# app/main.py
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from .models import NextJSDeploymentConfig, DeploymentResponse # Assuming models.py is in the same directory 'app'
from .k8s_utils import apply_mi_configuration, get_mi_status
import uvicorn
import traceback # For detailed error logging

app = FastAPI(
    title="WSO2 MI Autoscaling Demo Backend",
    version="1.0.1", # Updated version
    description="API to manage WSO2 MI deployment configurations and provide real-time status."
)

# --- CORS Configuration ---
origins = [
    "http://localhost:3000", # Next.js default dev port
    # Add any other origins if necessary
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- API Endpoints ---

@app.post("/api/deploy-mi", response_model=DeploymentResponse, tags=["Deployment"])
async def deploy_micro_integrator(payload: NextJSDeploymentConfig = Body(...)):
    """
    Receives deployment configuration and applies it to WSO2 MI on Kubernetes.
    """
    print(f"Received deployment payload: {payload.dict()}")
    if payload.maxReplicas < payload.minReplicas:
        raise HTTPException(
            status_code=400, 
            detail="maxReplicas cannot be less than minReplicas."
        )
    try:
        result_details = await apply_mi_configuration(payload)
        return DeploymentResponse(
            message="WSO2 MI configuration submitted successfully. Changes are being applied.",
            details=result_details
        )
    except ValueError as ve:
        print(f"Configuration error: {ve}")
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        print(f"An unexpected error occurred during deployment: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")

@app.get("/api/status", tags=["Status"])
async def get_current_status_endpoint(): # Renamed to avoid conflict with imported get_mi_status
    """
    Returns current status of WSO2 MI: pod count, HPA status, CPU/Memory usage.
    """
    try:
        status = await get_mi_status()
        if status.get("error"):
             # You might want to return a different HTTP status code for partial errors
            print(f"Partial error fetching status: {status.get('error')}")
        return status
    except Exception as e:
        print(f"Error in /api/status endpoint: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to fetch MI status: {str(e)}")


@app.get("/", tags=["Root"])
async def read_root():
    return {"message": "Welcome to the WSO2 MI Autoscaling Demo Backend!"}

# --- For running directly with uvicorn (local development) ---
if __name__ == "__main__":
    # Ensure Kubeconfig is loaded when k8s_utils is imported
    # No explicit call needed here if k8s_utils handles it at import time.
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
