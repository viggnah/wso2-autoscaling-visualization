// k6-scripts/ramping_load_test.js
import http from 'k6/http';
import { sleep, check } from 'k6';
import { Trend } from 'k6/metrics'; // Import Trend for custom metrics if needed

// --- Configuration (can be overridden by environment variables) ---
const TARGET_URL_DEFAULT = 'http://localhost:8290/echo'; // Matches frontend default
const STAGES_DEFAULT = [ // Updated to shorter, frontend default stages
  { duration: '30s', target: 5 },
  { duration: '1m', target: 5 },
  { duration: '30s', target: 15 },
  { duration: '1m30s', target: 15 },
  { duration: '30s', target: 0 },
];
const PAYLOAD_DEFAULT = JSON.stringify({
  message: "k6 load test",
  timestamp: new Date().toISOString(),
  iteration: 0 
});

const TARGET_URL = __ENV.K6_TARGET_URL || TARGET_URL_DEFAULT;
const K6_STAGES_JSON = __ENV.K6_STAGES_JSON;
let K6_STAGES;

try {
  if (K6_STAGES_JSON) {
    K6_STAGES = JSON.parse(K6_STAGES_JSON);
    if (!Array.isArray(K6_STAGES) || K6_STAGES.some(s => !s.duration || typeof s.target !== 'number')) {
      console.error("Invalid K6_STAGES_JSON format. Using default stages.");
      K6_STAGES = STAGES_DEFAULT;
    }
  } else {
    K6_STAGES = STAGES_DEFAULT;
  }
} catch (e) {
  console.error(`Error parsing K6_STAGES_JSON: ${e}. Using default stages.`);
  K6_STAGES = STAGES_DEFAULT;
}

export const options = {
  executor: 'ramping-vus',
  stages: K6_STAGES,
  thresholds: {
    'http_req_failed': ['rate<0.02'], 
    'http_req_duration': ['p(95)<1500', 'p(99)<3000'], // Adjusted thresholds slightly
  },
  // summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'], // This is for console summary, not handleSummary
};

// Custom trend metric for better aggregation if needed (optional)
// const myTrend = new Trend('my_custom_trend');

console.log(`k6 starting test with target URL: ${TARGET_URL}`);
console.log(`k6 stages: ${JSON.stringify(options.stages)}`);

export default function () {
  const payload = JSON.parse(PAYLOAD_DEFAULT);
  payload.timestamp = new Date().toISOString();
  payload.vu = __VU;
  payload.iter = __ITER;

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    tags: { name: 'WSO2MIEchoTest' }
  };

  const res = http.post(TARGET_URL, JSON.stringify(payload), params);

  check(res, {
    'is status 200': (r) => r.status === 200,
    'response body contains echoed message': (r) => {
      try {
        const body = r.json();
        return typeof body === 'object' && body !== null && 
               typeof body.json === 'object' && body.json !== null &&
               body.json.message === payload.message;
      } catch (e) {
        // console.error(`Error parsing response JSON for VU ${__VU}, iter ${__ITER}: ${e}, Body: ${r.body}`);
        return false;
      }
    },
  });

  if (res.status !== 200) {
    console.error(`Request failed! VU: ${__VU}, Iter: ${__ITER}, Status: ${res.status}, Body: ${res.body}`);
  }
  // myTrend.add(res.timings.duration); // Add to custom trend if using

  sleep(1);
}

// handleSummary processes the summary data at the end of the test
export function handleSummary(data) {
  console.log('Preparing k6 summary data...');

  // We want to output the summary as a single line of JSON to stdout
  // so the FastAPI backend can easily parse it.
  const summaryData = {
    total_requests: data.metrics['http_reqs'] ? data.metrics['http_reqs'].values.count : 0,
    failed_requests: data.metrics['http_req_failed'] ? data.metrics['http_req_failed'].values.fails : 0,
    vus_max: data.metrics['vus_max'] ? data.metrics['vus_max'].values.value : 0,
    iterations: data.metrics['iterations'] ? data.metrics['iterations'].values.count : 0,
    iteration_duration_avg_ms: data.metrics['iteration_duration'] ? data.metrics['iteration_duration'].values.avg : 0,
    // HTTP request duration metrics (in milliseconds)
    http_req_duration_avg_ms: data.metrics['http_req_duration'] ? data.metrics['http_req_duration'].values.avg : 0,
    http_req_duration_min_ms: data.metrics['http_req_duration'] ? data.metrics['http_req_duration'].values.min : 0,
    http_req_duration_med_ms: data.metrics['http_req_duration'] ? data.metrics['http_req_duration'].values.med : 0,
    http_req_duration_max_ms: data.metrics['http_req_duration'] ? data.metrics['http_req_duration'].values.max : 0,
    http_req_duration_p90_ms: data.metrics['http_req_duration'] ? data.metrics['http_req_duration'].values['p(90)'] : 0,
    http_req_duration_p95_ms: data.metrics['http_req_duration'] ? data.metrics['http_req_duration'].values['p(95)'] : 0,
    http_req_duration_p99_ms: data.metrics['http_req_duration'] ? data.metrics['http_req_duration'].values['p(99)'] : 0,
    // Data sent/received
    data_sent_bytes: data.metrics['data_sent'] ? data.metrics['data_sent'].values.count : 0,
    data_received_bytes: data.metrics['data_received'] ? data.metrics['data_received'].values.count : 0,
  };

  // Output the summary data as a JSON string to stdout
  // Prepend with a specific marker so backend can identify it.
  const summaryJSON = JSON.stringify(summaryData);
  console.log(`K6_SUMMARY_JSON_START${summaryJSON}K6_SUMMARY_JSON_END`);

  // k6 also requires handleSummary to return an object for its own reporting or cloud services.
  // We can return a simple object or a path to a file.
  return {
    'stdout': '', // Suppress default summary to stdout if we are logging our JSON
    // Or, you can save the detailed summary to a file if needed:
    // "summary.json": JSON.stringify(data, null, 2), 
  };
}

export function teardown(data) {
  console.log(`k6 test finished. Max VUs: ${options.stages.reduce((max, s) => Math.max(max, s.target), 0)}`);
}
