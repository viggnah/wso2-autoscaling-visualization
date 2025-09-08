# app/main.py
from fastapi import FastAPI, HTTPException, Body, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict, Any 
from .models import (
    NextJSDeploymentConfig, DeploymentResponse, 
    K6ConfigPayload, K6TestStatusResponse, K6Stage,
)
from .k8s_utils import apply_mi_configuration, get_mi_status, KUBE_CONFIG_LOADED
import uvicorn
import traceback
import subprocess
import os
import json
import signal
import re 
import asyncio # Added for asyncio.to_thread

app = FastAPI(
    title="WSO2 MI Autoscaling Demo Backend",
    version="1.0.6", # Updated version
    description="API to manage WSO2 MI deployment, trigger k6 load tests, and provide summaries."
)

# --- CORS Configuration ---
origins = [ "http://localhost:3000" ]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

# --- Global state ---
k6_process: subprocess.Popen | None = None
k6_last_summary: Dict[str, Any] | None = None 

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
K6_SCRIPT_PATH = os.path.join(BASE_DIR, "k6-scripts", "ramping_load_test.js")
print(f"FastAPI K6_SCRIPT_PATH resolved to: {K6_SCRIPT_PATH}")


def parse_and_validate_stages(stages_json_str: str) -> List[K6Stage]:
    try:
        stages_list = json.loads(stages_json_str)
        if not isinstance(stages_list, list): raise ValueError("Stages JSON must be an array.")
        return [K6Stage(**stage_dict) for stage_dict in stages_list]
    except json.JSONDecodeError as e: raise ValueError(f"Invalid JSON for stages: {e}")
    except Exception as e: raise ValueError(f"Invalid stage config: {e}")

# Function to run blocking IO in a separate thread
def blocking_read_stream(stream):
    lines = []
    if stream:
        for line in iter(stream.readline, ''):
            lines.append(line.strip())
        stream.close()
    return lines

def blocking_process_wait(process: subprocess.Popen):
    return process.wait()

async def log_k6_output_and_capture_summary(process: subprocess.Popen):
    global k6_last_summary, k6_process
    
    summary_regex = re.compile(r"K6_SUMMARY_JSON_START(.*)K6_SUMMARY_JSON_END")
    
    # Read stdout and stderr in separate threads to avoid blocking
    stdout_lines = await asyncio.to_thread(blocking_read_stream, process.stdout)
    stderr_lines = await asyncio.to_thread(blocking_read_stream, process.stderr)

    for line in stdout_lines:
        print(f"[k6_stdout] {line}")
        match = summary_regex.search(line)
        if match:
            summary_json_str = match.group(1)
            try:
                k6_last_summary = json.loads(summary_json_str)
                print(f"[k6_summary_captured] Successfully parsed k6 summary JSON.")
            except json.JSONDecodeError as e:
                print(f"[k6_summary_error] Failed to parse k6 summary JSON: {e}")
                print(f"[k6_summary_error] Offending string part: {summary_json_str[:200]}...")
    
    for line in stderr_lines:
        print(f"[k6_stderr] {line}")
    
    return_code = await asyncio.to_thread(blocking_process_wait, process)
    print(f"k6 process {process.pid} finished with code {return_code}")
    
    if k6_process and k6_process.pid == process.pid:
        k6_process = None 

# --- API Endpoints ---
@app.post("/api/deploy-mi", response_model=DeploymentResponse, tags=["MI Deployment"])
async def deploy_micro_integrator(payload: NextJSDeploymentConfig = Body(...)):
    if not KUBE_CONFIG_LOADED:
        raise HTTPException(status_code=503, detail="Kubernetes client not initialized on backend.")
    print(f"Received MI deployment payload: {payload.dict(by_alias=True)}") 
    if payload.maxReplicas < payload.minReplicas:
        raise HTTPException(status_code=400, detail="maxReplicas < minReplicas.")
    try:
        result_details = await apply_mi_configuration(payload)
        return DeploymentResponse(
            message="WSO2 MI configuration submitted. Changes are being applied.",
            details=result_details
        )
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Unexpected error during MI deployment: {str(e)}")


@app.get("/api/mi-status", tags=["MI Status"])
async def get_current_mi_status_endpoint():
    try:
        status = await get_mi_status()
        return status 
    except Exception as e: 
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to fetch MI status: {str(e)}")

@app.post("/api/load-test/start", response_model=K6TestStatusResponse, tags=["Load Test"])
async def start_load_test(background_tasks: BackgroundTasks, payload: K6ConfigPayload = Body(...)):
    global k6_process, k6_last_summary
    if k6_process and k6_process.poll() is None:
        raise HTTPException(status_code=400, detail="A k6 load test is already running.")
    
    k6_last_summary = None 

    try:
        validated_stages = parse_and_validate_stages(payload.stages_json)
        stages_json_for_k6 = payload.stages_json
        print(f"Starting k6: Target: {payload.target_url}, Stages: {stages_json_for_k6}")
        if not os.path.exists(K6_SCRIPT_PATH):
            raise HTTPException(status_code=500, detail=f"k6 script not found: {K6_SCRIPT_PATH}")

        k6_env = os.environ.copy()
        k6_env.update({
            "K6_TARGET_URL": payload.target_url, "K6_STAGES_JSON": stages_json_for_k6,
            "K6_PROMETHEUS_RW_SERVER_URL": "", "K6_NO_USAGE_REPORT": "true"
        })
        cmd = ["k6", "run", K6_SCRIPT_PATH]
        k6_process = subprocess.Popen(cmd, env=k6_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1) 
        
        background_tasks.add_task(log_k6_output_and_capture_summary, k6_process)

        return K6TestStatusResponse(is_running=True, message="k6 load test started.", pid=k6_process.pid)
    except ValueError as ve: raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to start k6: {str(e)}")

@app.post("/api/load-test/stop", response_model=K6TestStatusResponse, tags=["Load Test"])
async def stop_load_test():
    global k6_process
    if not (k6_process and k6_process.poll() is None):
        if k6_process: k6_process = None 
        return K6TestStatusResponse(is_running=False, message="No k6 test running or already finished.")
    try:
        pid = k6_process.pid
        print(f"Stopping k6 process PID: {pid}")
        k6_process.send_signal(signal.SIGINT)
        # The background task will handle process cleanup.
        # For immediate UI feedback, we can assume it will stop.
        # A more robust solution might involve waiting for the background task or k6_process.wait()
        # but that would make this 'stop' endpoint blocking.
        # Let the polling of /api/load-test/status update the final state.
        return K6TestStatusResponse(is_running=False, message=f"Stop signal sent to k6 test (PID: {pid}). It will terminate shortly.", pid=pid)
    except Exception as e:
        traceback.print_exc()
        current_pid = k6_process.pid if k6_process else None
        # Don't set k6_process to None here if stop signal failed, let polling handle it.
        raise HTTPException(status_code=500, detail=f"Failed to send stop signal to k6 (PID: {current_pid}): {str(e)}")


@app.get("/api/load-test/status", response_model=K6TestStatusResponse, tags=["Load Test"])
async def get_load_test_status():
    global k6_process
    if k6_process and k6_process.poll() is None: 
        return K6TestStatusResponse(is_running=True, message="k6 load test is running.", pid=k6_process.pid)
    
    # If k6_process is not None here, it means it has finished (poll() is not None).
    # The background task `log_k6_output_and_capture_summary` is responsible for setting k6_process to None.
    # If this endpoint is called before the background task completes that, we might report it as finished.
    if k6_process and k6_process.poll() is not None:
        # It's better to let the background task clear k6_process to avoid race conditions
        # with summary capture. For now, just report based on poll().
        return K6TestStatusResponse(is_running=False, message="k6 load test has finished.", pid=k6_process.pid)
        
    return K6TestStatusResponse(is_running=False, message="No k6 test running or has finished.")


@app.get("/api/load-test/summary", response_model=Dict[str, Any], tags=["Load Test"])
async def get_load_test_summary():
    global k6_last_summary
    if k6_last_summary:
        return k6_last_summary
    else:
        status_msg = "No summary available. Test may not have completed, is still running, or summary was not captured."
        if k6_process and k6_process.poll() is None:
            status_msg = "Load test is currently running. Summary will be available after completion."
        raise HTTPException(status_code=404, detail=status_msg)


@app.get("/", tags=["Root"])
async def read_root(): return {"message": "Welcome!"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
