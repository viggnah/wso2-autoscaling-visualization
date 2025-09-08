// app/page.tsx
"use client";

import React, { useState, useEffect, ChangeEvent, FormEvent, useCallback, useMemo, useRef } from 'react';
import StatusChart from '../components/StatusChart';

// --- Interfaces ---
interface DeploymentConfig {
  minReplicas: number;
  maxReplicas: number;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  backendDelayMs: number;
}

interface InputFieldProps {
  label: string;
  name: string;
  type?: string;
  value: string | number;
  onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  min?: string | number;
  pattern?: string;
  title?: string;
  placeholder?: string;
  rows?: number; 
  step?: string | number;
  inputInfo?: string;
}

interface ChartDataPoint {
  timestamp: string;
  timeLabel: string;
  activePods?: number;
  totalCpuMillicores?: number;
}

interface ApiStatusResponse {
  timestamp: string;
  active_pods: number;
  total_cpu_millicores: number;
  hpa_status: {
    minReplicas?: number;
    maxReplicas?: number;
    currentReplicas?: number;
    desiredReplicas?: number;
    lastScaleTime?: string;
    error?: string | null; 
  };
  deployment_status: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
    error?: string | null; 
  };
  error: string | null; 
}

interface K6ConfigState {
  targetURL: string;
  stagesJSON: string;
}

interface K6SummaryData {
  total_requests?: number;
  failed_requests?: number;
  vus_max?: number;
  iterations?: number;
  iteration_duration_avg_ms?: number;
  http_req_duration_avg_ms?: number;
  http_req_duration_min_ms?: number;
  http_req_duration_med_ms?: number;
  http_req_duration_max_ms?: number;
  http_req_duration_p90_ms?: number;
  http_req_duration_p95_ms?: number;
  http_req_duration_p99_ms?: number;
  data_sent_bytes?: number;
  data_received_bytes?: number;
}


const MAX_CHART_DATA_POINTS = 60;
const DEFAULT_K6_STAGES_JSON = JSON.stringify([
  { duration: '30s', target: 20 }, { duration: '1m', target: 20 },
  { duration: '30s', target: 50 }, { duration: '1m30s', target: 50 },
  { duration: '30s', target: 0 },
], null, 2);

const InputField: React.FC<InputFieldProps> = React.memo(({ 
    label, name, type = "text", value, onChange, 
    min, pattern, title, placeholder, rows, step, inputInfo 
}) => { 
    return (
        <div>
            <label htmlFor={name} className="block text-sm font-medium text-slate-300 mb-1">
                {label}
                {inputInfo && <span className="block text-xs text-slate-400 mt-0.5">{inputInfo}</span>}
            </label>
            {type === 'textarea' ? (
                <textarea
                    name={name} id={name} value={value as string} onChange={onChange}
                    placeholder={placeholder || label} required rows={rows || 3}
                    className="w-full bg-slate-700 border-slate-600 text-slate-100 rounded-md shadow-sm focus:ring-sky-500 focus:border-sky-500 py-2 px-3 transition-colors duration-150 font-mono text-xs"
                />
            ) : (
                <input
                    type={type} name={name} id={name} value={value} onChange={onChange}
                    min={min} step={step} pattern={pattern} title={title} placeholder={placeholder || label} required
                    className="w-full bg-slate-700 border-slate-600 text-slate-100 rounded-md shadow-sm focus:ring-sky-500 focus:border-sky-500 py-2 px-3 transition-colors duration-150"
                />
            )}
        </div>
    );
});
InputField.displayName = 'InputField';


export default function HomePage() {
  const [config, setConfig] = useState<DeploymentConfig>({
    minReplicas: 1, maxReplicas: 5, cpuRequest: "500m", cpuLimit: "1.5",
    memoryRequest: "1.5Gi", memoryLimit: "2Gi", backendDelayMs: 3000,
  });

  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [deployStatusMessage, setDeployStatusMessage] = useState<string>(''); 
  const [deployStatusType, setDeployStatusType] = useState<'success' | 'error' | ''>('');
  const [miStatusError, setMiStatusError] = useState<string | null>(null);
  const [currentPods, setCurrentPods] = useState<number>(0);
  const [currentCpu, setCurrentCpu] = useState<number>(0);
  const [hpaDetails, setHpaDetails] = useState<ApiStatusResponse['hpa_status'] | null>(null);
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [k6Config, setK6Config] = useState<K6ConfigState>({
    targetURL: "http://localhost:8290/echo", 
    stagesJSON: DEFAULT_K6_STAGES_JSON,
  });
  const [isK6Running, setIsK6Running] = useState<boolean>(false);
  const [k6StatusMessage, setK6StatusMessage] = useState<string>('');
  const [isK6ButtonLoading, setIsK6ButtonLoading] = useState<boolean>(false);
  const [k6LastSummary, setK6LastSummary] = useState<K6SummaryData | null>(null);

  const handleConfigChange = useCallback((e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    const targetInput = e.target as HTMLInputElement; 
    const isNumberInput = targetInput.type === 'number';
    setConfig(prevConfig => ({
      ...prevConfig,
      [name]: isNumberInput ? parseInt(value, 10) || (name === 'backendDelayMs' ? 0 : 1) : value,
    }));
  }, []);

  const handleK6ConfigChange = useCallback((e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setK6Config(prevK6Config => ({ ...prevK6Config, [name]: value }));
  }, []);

  const handleDeploy = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsDeploying(true);
    setDeployStatusMessage(''); setDeployStatusType(''); setMiStatusError(null);
    try {
      const response = await fetch('http://localhost:8000/api/deploy-mi', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await response.json();
      if (!response.ok) {
        const errorDetail = data.detail ? (Array.isArray(data.detail) ? data.detail.map((err: any) => `${err.loc.join('.')}: ${err.msg}`).join('; ') : data.detail) : 'MI Deployment failed';
        throw new Error(errorDetail);
      }
      setDeployStatusMessage(data.message || 'MI configuration applied.');
      setDeployStatusType('success');
      fetchMIStatus(); 
    } catch (error: any) {
      setDeployStatusMessage(`MI Deploy Error: ${error.message}`);
      setDeployStatusType('error');
    } finally {
      setIsDeploying(false);
    }
  };

  const fetchMIStatus = useCallback(async () => {
    try {
      const response = await fetch('http://localhost:8000/api/mi-status');
      if (!response.ok) { 
        const errorText = await response.text().catch(() => "Unknown API error");
        console.error("MI Status fetch API error:", response.status, errorText);
        setMiStatusError(`Failed to fetch MI status: Server responded with ${response.status}. Check backend logs.`);
        setCurrentPods(0); setCurrentCpu(0); setHpaDetails(null); 
        return; 
      }
      const data: ApiStatusResponse = await response.json();

      if (data.error) {
        console.warn("Error reported by MI status API:", data.error);
        setMiStatusError(data.error); 
        setCurrentPods(data.active_pods || 0); 
        setCurrentCpu(data.total_cpu_millicores || 0);
        setHpaDetails(data.hpa_status || null);
      } else {
        setMiStatusError(null); 
      }
      
      setCurrentPods(data.active_pods || 0);
      setCurrentCpu(data.total_cpu_millicores || 0);
      setHpaDetails(data.hpa_status || null);

      if (!data.error) { // Only add valid data points if no top-level error
        const newPoint: ChartDataPoint = {
          timestamp: data.timestamp,
          timeLabel: new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          activePods: data.active_pods || 0,
          totalCpuMillicores: data.total_cpu_millicores || 0,
        };
        setChartData(prevData => {
          const updatedData = [...prevData, newPoint];
          return updatedData.length > MAX_CHART_DATA_POINTS 
                 ? updatedData.slice(updatedData.length - MAX_CHART_DATA_POINTS) 
                 : updatedData;
        });
      }
    } catch (error: any) { 
      console.error("Critical failure fetching MI status (e.g. network error):", error);
      setMiStatusError(`Network or parsing error fetching MI status: ${error.message}. Is the backend running?`);
    }
  }, []);

  const fetchK6SummaryAPI = async () => { // Renamed to avoid conflict
    try {
        const response = await fetch('http://localhost:8000/api/load-test/summary');
        if (response.ok) {
            const summaryData: K6SummaryData = await response.json();
            setK6LastSummary(summaryData);
            setK6StatusMessage("Load test finished. Summary available.");
        } else {
            const errorData = await response.json().catch(() => ({ detail: "Failed to fetch summary"}));
            console.warn("Failed to fetch k6 summary:", errorData.detail || response.statusText);
            if (!k6StatusMessage.toLowerCase().includes('error')) {
                 setK6StatusMessage("Load test finished. Summary could not be retrieved.");
            }
        }
    } catch (error: any) {
        console.error("Error fetching k6 summary:", error);
        if (!k6StatusMessage.toLowerCase().includes('error')) {
            setK6StatusMessage("Error fetching k6 summary.");
        }
    }
  };

  const isK6RunningRef = useRef(isK6Running);
  const fetchK6Status = useCallback(async () => {
    try {
      const response = await fetch('http://localhost:8000/api/load-test/status');
      const data = await response.json(); 
      if (!response.ok) throw new Error(data.detail || data.message || 'Failed to fetch k6 status');
      
      const k6WasRunning = isK6RunningRef.current; 
      isK6RunningRef.current = data.is_running; 
      setIsK6Running(data.is_running); // Update state based on API response

      if (!data.is_running && k6WasRunning) { // Test just finished
        setK6StatusMessage(data.message || "Load test finished or stopped.");
        fetchK6SummaryAPI(); // Fetch summary when test transitions from running to not running
      } else if (data.is_running) {
         setK6StatusMessage(data.message || "Load test is running.");
         // Clear old summary when a new test starts or is found running
         if (!k6WasRunning) setK6LastSummary(null); 
      } else { // Not running and wasn't running before
        if (!k6StatusMessage.toLowerCase().includes('error')) {
            if (k6LastSummary && (data.message || "").includes("No k6 load test is running or has finished")) {
                // Keep "Summary available" message if summary exists
            } else {
                setK6StatusMessage(data.message || "Load test not running.");
            }
        }
      }
    } catch (error: any) {
      console.error("Failed to fetch k6 status:", error.message);
      if (!k6StatusMessage.toLowerCase().includes('error starting') && !k6StatusMessage.toLowerCase().includes('error stopping')) {
        setK6StatusMessage(`Error fetching k6 status: ${error.message}`);
      }
    }
  }, [k6StatusMessage, k6LastSummary]); // k6LastSummary dependency added

  useEffect(() => {
    isK6RunningRef.current = isK6Running;
  }, [isK6Running]);

  useEffect(() => {
    const miStatusIntervalId = setInterval(fetchMIStatus, 5000); 
    const k6StatusIntervalId = setInterval(fetchK6Status, 3000); 
    fetchMIStatus(); fetchK6Status();
    return () => { clearInterval(miStatusIntervalId); clearInterval(k6StatusIntervalId); };
  }, [fetchMIStatus, fetchK6Status]);

  const handleStartK6Test = async () => {
    setIsK6ButtonLoading(true); setK6StatusMessage('Starting load test...'); setMiStatusError(null);
    setK6LastSummary(null); // Clear previous summary
    try {
      JSON.parse(k6Config.stagesJSON); 
      const payloadToSend = { targetURL: k6Config.targetURL, stagesJSON: k6Config.stagesJSON };
      const response = await fetch('http://localhost:8000/api/load-test/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadToSend),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.message || 'Failed to start k6 test');
      setK6StatusMessage(data.message || "k6 load test started.");
      setIsK6Running(true); 
      isK6RunningRef.current = true; // Immediately update ref
    } catch (error: any) {
      setK6StatusMessage(`Error starting k6 test: ${error.message}`);
      setIsK6Running(false);
      isK6RunningRef.current = false;
    } finally {
      setIsK6ButtonLoading(false);
    }
  };

  const handleStopK6Test = async () => {
    setIsK6ButtonLoading(true); setK6StatusMessage('Stopping load test...');
    try {
      const response = await fetch('http://localhost:8000/api/load-test/stop', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.message || 'Failed to stop k6 test');
      setK6StatusMessage(data.message || "k6 load test stop signal sent.");
      setIsK6Running(false); 
      isK6RunningRef.current = false; // Immediately update ref
      // Optionally try to fetch summary immediately after stop
      // await new Promise(resolve => setTimeout(resolve, 1000)); 
      // fetchK6SummaryAPI(); // Or let the polling in fetchK6Status handle it
    } catch (error: any) {
      setK6StatusMessage(`Error stopping k6 test: ${error.message}`);
    } finally {
      setIsK6ButtonLoading(false);
    }
  };
  
  const k6ButtonText = useMemo(() => {
    if (isK6ButtonLoading && !isK6Running) return 'Starting...'; // Specifically for start button
    if (isK6ButtonLoading && isK6Running) return 'Stopping...'; // Specifically for stop button
    if (isK6Running) return 'Load Test Running';
    return 'Start Load Test';
  }, [isK6ButtonLoading, isK6Running]);

  const formatK6SummaryValue = (value: number | undefined, unit: string = '', decimals: number = 2) => {
    if (value === undefined || value === null || Number.isNaN(value)) return 'N/A';
    return `${value.toLocaleString(undefined, { minimumFractionDigits: unit === 'ms' ? 0 : decimals, maximumFractionDigits: unit === 'ms' ? 0 : decimals })}${unit}`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 py-8 px-4 sm:px-6 lg:px-8 text-slate-100 font-sans">
      <div className="max-w-7xl mx-auto">
        <header className="mb-10 text-center">
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl bg-clip-text text-transparent bg-gradient-to-r from-sky-400 to-cyan-300">
            WSO2 MI Autoscaling Demo
          </h1>
        </header>

        {miStatusError && (
          <div className="mb-6 p-4 rounded-md shadow-lg bg-amber-600/90 border border-amber-500 text-white">
            <h3 className="text-lg font-semibold mb-1">MI Status Update Warning:</h3>
            <p className="text-sm whitespace-pre-wrap">{miStatusError}</p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-4">
            <form onSubmit={handleDeploy} className="bg-slate-800 shadow-2xl rounded-xl p-6 space-y-6 h-fit sticky top-8">
              <div>
                <h2 className="text-xl font-semibold text-sky-400 border-b border-slate-700 pb-2 mb-4">
                  MI Deployment
                </h2>
                <div className="space-y-4">
                  <InputField label="Min Replicas" name="minReplicas" type="number" value={config.minReplicas} onChange={handleConfigChange} min="1" inputInfo="Min HPA replicas" />
                  <InputField label="Max Replicas" name="maxReplicas" type="number" value={config.maxReplicas} onChange={handleConfigChange} min="1" inputInfo="Max HPA replicas" />
                  <InputField label="CPU Request" name="cpuRequest" value={config.cpuRequest} onChange={handleConfigChange} placeholder="e.g., 250m" title="Examples: 250m (0.25 core), 1 (1 core)" inputInfo="Format: '100m' or '0.5' or '1'"/>
                  <InputField label="CPU Limit" name="cpuLimit" value={config.cpuLimit} onChange={handleConfigChange} placeholder="e.g., 1" title="Examples: 500m (0.5 core), 2 (2 cores)" inputInfo="Format: '500m' or '1' or '1.5'"/>
                  <InputField label="Memory Request" name="memoryRequest" value={config.memoryRequest} onChange={handleConfigChange} placeholder="e.g., 2Gi" title="Examples: 512Mi, 1Gi, 2Gi" inputInfo="Format: '512Mi' or '1Gi'"/>
                  <InputField label="Memory Limit" name="memoryLimit" value={config.memoryLimit} onChange={handleConfigChange} placeholder="e.g., 2Gi" title="Examples: 1Gi, 2Gi, 4Gi" inputInfo="Format: '1Gi' or '2048Mi'"/>
                  <InputField label="MI Backend Delay (ms)" name="backendDelayMs" type="number" value={config.backendDelayMs} onChange={handleConfigChange} min="0" inputInfo="Simulated delay in MI (milliseconds)"/>
                </div>
              </div>
              <div className="pt-4 border-t border-slate-700">
                <button type="submit" disabled={isDeploying}
                        className="w-full btn-primary group">
                  {isDeploying && ( <svg className="animate-spin -ml-1 mr-3 h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"> <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"></circle> <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" className="opacity-75"></path> </svg> )}
                  <span>{isDeploying ? 'Applying...' : 'Apply MI Config'}</span>
                </button>
              </div>
               {deployStatusMessage && (
                  <div className={`mt-4 p-3 rounded-md text-sm ${deployStatusType === 'success' ? 'bg-green-600/80 border-green-500' : 'bg-red-600/80 border-red-500'}`}>
                      <p className="whitespace-pre-wrap">{deployStatusMessage}</p>
                  </div>
              )}
            </form>
          </div>

          <div className="lg:col-span-8 space-y-8">
            <div className="bg-slate-800 shadow-2xl rounded-xl p-6">
                <h2 className="text-xl font-semibold text-sky-400 border-b border-slate-700 pb-2 mb-4">
                    Current MI Status
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                    <div className="bg-slate-700 p-3 rounded-md"><p className="text-slate-400">Active Pods:</p><p className="text-sky-300 font-bold text-2xl">{currentPods}</p></div>
                    <div className="bg-slate-700 p-3 rounded-md"><p className="text-slate-400">Total CPU (cores):</p><p className="text-sky-300 font-bold text-2xl">{(currentCpu / 1000).toFixed(2)}</p></div>
                    <div className="bg-slate-700 p-3 rounded-md"><p className="text-slate-400">Desired Replicas (HPA):</p><p className="text-sky-300 font-bold text-2xl">{hpaDetails?.desiredReplicas ?? 'N/A'}</p></div>
                </div>
                 {hpaDetails?.lastScaleTime && (<p className="text-xs text-slate-500 mt-3">HPA Last Scaled: {new Date(hpaDetails.lastScaleTime).toLocaleString()}</p>)}
                 {hpaDetails?.error && (<p className="text-xs text-amber-400 mt-3">HPA Status Note: {hpaDetails.error}</p>)}
            </div>

            <div className="bg-slate-800 shadow-2xl rounded-xl p-6 space-y-6">
                <h2 className="text-xl font-semibold text-sky-400 border-b border-slate-700 pb-2 mb-4">
                    k6 Load Test Control
                </h2>
                <InputField label="Target URL" name="targetURL" value={k6Config.targetURL} onChange={handleK6ConfigChange} placeholder="http://localhost:8290/echo" inputInfo="MI /echo endpoint" />
                <div>
                    <label htmlFor="stagesJSON" className="block text-sm font-medium text-slate-300 mb-1">
                        k6 Stages (JSON)
                        <span className="block text-xs text-slate-400 mt-0.5">Defines VU ramping. See k6 docs for format.</span>
                    </label>
                    <textarea
                        name="stagesJSON" id="stagesJSON" value={k6Config.stagesJSON} onChange={handleK6ConfigChange}
                        rows={6}
                        className="w-full bg-slate-700 border-slate-600 text-slate-100 rounded-md shadow-sm focus:ring-sky-500 focus:border-sky-500 py-2 px-3 transition-colors duration-150 font-mono text-xs"
                    />
                </div>
                
                <div className="flex space-x-4 pt-4 border-t border-slate-700">
                    <button onClick={handleStartK6Test} disabled={isK6Running || isK6ButtonLoading} className="flex-1 py-3 px-4 btn-primary group disabled:bg-sky-700 disabled:from-slate-600 disabled:to-slate-500">
                        {isK6ButtonLoading && !isK6Running && (<svg className="animate-spin -ml-1 mr-3 h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"className="opacity-25"></circle><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" className="opacity-75"></path></svg>)}
                        <span>{k6ButtonText}</span>
                    </button>
                    <button onClick={handleStopK6Test} disabled={!isK6Running || isK6ButtonLoading} className="flex-1 py-3 px-4 btn-danger group disabled:bg-red-700 disabled:from-slate-600 disabled:to-slate-500">
                         {isK6ButtonLoading && isK6Running && (<svg className="animate-spin -ml-1 mr-3 h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"className="opacity-25"></circle><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" className="opacity-75"></path></svg>)}
                        <span>{isK6ButtonLoading && isK6Running ? 'Stopping...' : 'Stop Load Test'}</span>
                    </button>
                </div>
                {k6StatusMessage && (
                    <div className={`mt-4 p-3 rounded-md text-sm ${
                        isK6Running ? 'bg-sky-700/80 border-sky-600' 
                        : k6StatusMessage.toLowerCase().includes('error') ? 'bg-red-600/80 border-red-500' 
                        : k6LastSummary ? 'bg-emerald-700/80 border-emerald-600' // Green for summary available
                        : 'bg-slate-600/80 border-slate-500'}`
                    }>
                        <p className="whitespace-pre-wrap">{k6StatusMessage}</p>
                    </div>
                )}
            </div>

            {/* --- k6 Load Test Summary Section --- */}
            {k6LastSummary && !isK6Running && (
              <div className="bg-slate-800 shadow-2xl rounded-xl p-6">
                <h2 className="text-xl font-semibold text-emerald-400 border-b border-slate-700 pb-2 mb-4">
                  Last k6 Load Test Summary
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
                  <div><span className="text-slate-400">Total Requests:</span> <span className="font-medium text-slate-200">{formatK6SummaryValue(k6LastSummary.total_requests)}</span></div>
                  <div><span className="text-slate-400">Failed Requests:</span> <span className="font-medium text-red-400">{formatK6SummaryValue(k6LastSummary.failed_requests)}</span></div>
                  <div><span className="text-slate-400">Max VUs:</span> <span className="font-medium text-slate-200">{formatK6SummaryValue(k6LastSummary.vus_max)}</span></div>
                  <div><span className="text-slate-400">Iterations:</span> <span className="font-medium text-slate-200">{formatK6SummaryValue(k6LastSummary.iterations)}</span></div>
                  
                  <div className="col-span-full mt-2 pt-2 border-t border-slate-700/50 text-slate-400 text-xs">Request Duration (ms):</div>
                  <div><span className="text-slate-400">Avg:</span> <span className="font-medium text-slate-200">{formatK6SummaryValue(k6LastSummary.http_req_duration_avg_ms, 'ms')}</span></div>
                  <div><span className="text-slate-400">Min:</span> <span className="font-medium text-slate-200">{formatK6SummaryValue(k6LastSummary.http_req_duration_min_ms, 'ms')}</span></div>
                  <div><span className="text-slate-400">Med:</span> <span className="font-medium text-slate-200">{formatK6SummaryValue(k6LastSummary.http_req_duration_med_ms, 'ms')}</span></div>
                  <div><span className="text-slate-400">Max:</span> <span className="font-medium text-slate-200">{formatK6SummaryValue(k6LastSummary.http_req_duration_max_ms, 'ms')}</span></div>
                  <div><span className="text-slate-400">P(90):</span> <span className="font-medium text-slate-200">{formatK6SummaryValue(k6LastSummary.http_req_duration_p90_ms, 'ms')}</span></div>
                  <div><span className="text-slate-400">P(95):</span> <span className="font-medium text-slate-200">{formatK6SummaryValue(k6LastSummary.http_req_duration_p95_ms, 'ms')}</span></div>
                  
                  <div className="col-span-full mt-2 pt-2 border-t border-slate-700/50 text-slate-400 text-xs">Data Transfer:</div>
                  <div><span className="text-slate-400">Sent:</span> <span className="font-medium text-slate-200">{formatK6SummaryValue((k6LastSummary.data_sent_bytes || 0) / 1024, ' KB')}</span></div>
                  <div><span className="text-slate-400">Received:</span> <span className="font-medium text-slate-200">{formatK6SummaryValue((k6LastSummary.data_received_bytes || 0) / 1024, ' KB')}</span></div>
                </div>
              </div>
            )}

            <StatusChart data={chartData} metric="activePods" title="Active Pods Over Time" lineColor="#38bdf8" yAxisLabel="Pods" yAxisDomain={[0, 'dataMax + 1']} />
            <StatusChart data={chartData} metric="totalCpuMillicores" title="Total CPU Usage Over Time" lineColor="#67e8f9" yAxisLabel="Millicores" yAxisDomain={[0, 'dataMax + 100']} />
          </div>
        </div>
      </div>
    </div>
  );
}
