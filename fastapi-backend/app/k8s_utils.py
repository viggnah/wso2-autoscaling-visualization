# app/k8s_utils.py
from kubernetes import client, config
from kubernetes.client.rest import ApiException
from .models import NextJSDeploymentConfig # Use the direct payload model
import datetime # For timestamps

# --- Kubernetes Configuration ---
try:
    config.load_kube_config()
    print("Successfully loaded kubeconfig for k8s_utils.")
except config.ConfigException as e:
    print(f"Could not load kubeconfig: {e}. Trying in-cluster config...")
    try:
        config.load_incluster_config()
        print("Successfully loaded in-cluster config for k8s_utils.")
    except config.ConfigException:
        raise RuntimeError("k8s_utils: Could not configure Kubernetes client.")

# Kubernetes API clients
apps_v1_api = client.AppsV1Api()
autoscaling_v2_api = client.AutoscalingV2Api()
custom_objects_api = client.CustomObjectsApi() # For pod metrics

# --- Constants ---
NAMESPACE = "default"
MI_DEPLOYMENT_NAME = "wso2mi-deployment"
MI_HPA_NAME = "wso2mi-hpa"
MI_CONTAINER_NAME = "wso2mi-container"
MI_APP_LABEL = "wso2mi" # The 'app' label set in your wso2mi-deployment.yaml

async def apply_mi_configuration(payload: NextJSDeploymentConfig) -> dict:
    """
    Applies the given configuration to the WSO2 MI Deployment and HPA.
    """
    deployment_details = {}
    hpa_details = {}

    # 1. Configure MI Deployment
    try:
        current_deployment = apps_v1_api.read_namespaced_deployment(name=MI_DEPLOYMENT_NAME, namespace=NAMESPACE)
        
        if current_deployment.spec.template.spec.containers:
            for container in current_deployment.spec.template.spec.containers:
                if container.name == MI_CONTAINER_NAME:
                    container.resources.requests = {
                        "cpu": payload.cpuRequest,
                        "memory": payload.memoryRequest
                    }
                    container.resources.limits = {
                        "cpu": payload.cpuLimit,
                        "memory": payload.memoryLimit
                    }
                    
                    env_var_exists = False
                    if container.env:
                        for env_var in container.env:
                            if env_var.name == "MI_DELAY_MS":
                                env_var.value = str(payload.backendDelayMs)
                                env_var_exists = True
                                break
                        if not env_var_exists:
                            container.env.append(client.V1EnvVar(name="MI_DELAY_MS", value=str(payload.backendDelayMs)))
                    else:
                        container.env = [client.V1EnvVar(name="MI_DELAY_MS", value=str(payload.backendDelayMs))]
                    break
        
        apps_v1_api.patch_namespaced_deployment(name=MI_DEPLOYMENT_NAME, namespace=NAMESPACE, body=current_deployment)
        deployment_details = {"status": "patched", "name": MI_DEPLOYMENT_NAME}
        print(f"Patched Deployment '{MI_DEPLOYMENT_NAME}'.")

    except ApiException as e:
        if e.status == 404:
            print(f"Deployment '{MI_DEPLOYMENT_NAME}' not found. Please ensure it's created first.")
            raise ValueError(f"Deployment '{MI_DEPLOYMENT_NAME}' not found.") from e
        else:
            print(f"Error patching MI Deployment: {e}")
            raise ValueError(f"Error patching MI Deployment: {e.reason}") from e

    # 2. Configure HPA
    try:
        current_hpa = autoscaling_v2_api.read_namespaced_horizontal_pod_autoscaler(name=MI_HPA_NAME, namespace=NAMESPACE)
        current_hpa.spec.min_replicas = payload.minReplicas
        current_hpa.spec.max_replicas = payload.maxReplicas
        autoscaling_v2_api.patch_namespaced_horizontal_pod_autoscaler(name=MI_HPA_NAME, namespace=NAMESPACE, body=current_hpa)
        hpa_details = {"status": "patched", "name": MI_HPA_NAME}
        print(f"Patched HPA '{MI_HPA_NAME}'.")

    except ApiException as e:
        if e.status == 404:
            print(f"HPA '{MI_HPA_NAME}' not found. Please ensure it's created first.")
            raise ValueError(f"HPA '{MI_HPA_NAME}' not found.") from e
        else:
            print(f"Error patching HPA: {e}")
            raise ValueError(f"Error patching HPA: {e.reason}") from e
            
    return {"deployment": deployment_details, "hpa": hpa_details}

def parse_cpu_value(cpu_str: str) -> float:
    """Converts Kubernetes CPU string (e.g., '100m', '1') to millicores (float)."""
    if not cpu_str:
        return 0.0
    if cpu_str.endswith('m'): # millicores
        return float(cpu_str[:-1])
    if cpu_str.endswith('n'): # nanocores
        return float(cpu_str[:-1]) / 1_000_000
    try: # cores
        return float(cpu_str) * 1000
    except ValueError:
        return 0.0 # Or raise an error

async def get_mi_status():
    """
    Retrieves current status of MI: pod count, HPA status, and aggregated CPU/Memory usage.
    """
    current_timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    active_pods = 0
    total_cpu_millicores = 0.0
    # total_memory_bytes = 0 # Memory can be added similarly if needed

    hpa_status_data = {}
    deployment_status_data = {}

    try:
        # Get Deployment status for overall replica counts
        deployment = apps_v1_api.read_namespaced_deployment_status(name=MI_DEPLOYMENT_NAME, namespace=NAMESPACE)
        active_pods = deployment.status.ready_replicas if deployment.status.ready_replicas is not None else 0
        deployment_status_data = {
            "replicas": deployment.status.replicas if deployment.status.replicas is not None else 0,
            "readyReplicas": active_pods,
            "availableReplicas": deployment.status.available_replicas if deployment.status.available_replicas is not None else 0,
            "updatedReplicas": deployment.status.updated_replicas if deployment.status.updated_replicas is not None else 0,
        }
        
        # Get HPA status
        hpa = autoscaling_v2_api.read_namespaced_horizontal_pod_autoscaler_status(name=MI_HPA_NAME, namespace=NAMESPACE)
        hpa_status_data = {
            "minReplicas": hpa.spec.min_replicas, # From spec, not status
            "maxReplicas": hpa.spec.max_replicas, # From spec, not status
            "currentReplicas": hpa.status.current_replicas if hpa.status and hpa.status.current_replicas is not None else 0,
            "desiredReplicas": hpa.status.desired_replicas if hpa.status and hpa.status.desired_replicas is not None else 0,
        }
        if hpa.status and hpa.status.last_scale_time:
            hpa_status_data["lastScaleTime"] = hpa.status.last_scale_time.isoformat()
        
        # Get Pod Metrics if Metrics Server is available
        # Uses the label selector from your MI deployment
        pod_metrics_list = custom_objects_api.list_namespaced_custom_object(
            group="metrics.k8s.io",
            version="v1beta1",
            namespace=NAMESPACE,
            plural="pods",
            label_selector=f"app={MI_APP_LABEL}" # Use the app label for MI pods
        )
        
        for item in pod_metrics_list.get("items", []):
            pod_name = item.get("metadata", {}).get("name", "unknown-pod")
            for container_metrics in item.get("containers", []):
                if container_metrics.get("name") == MI_CONTAINER_NAME: # Ensure we sum for the correct container
                    cpu_usage_str = container_metrics.get("usage", {}).get("cpu", "0n") # nanocores usually
                    total_cpu_millicores += parse_cpu_value(cpu_usage_str)
                    # mem_usage_str = container_metrics.get("usage", {}).get("memory", "0Ki") # KiB usually
                    # total_memory_bytes += parse_memory_value(mem_usage_str) # You'd need a parse_memory_value
                    print(f"Pod: {pod_name}, Container: {MI_CONTAINER_NAME}, CPU: {cpu_usage_str}") # For debugging
                    break # Found the target container in this pod

    except ApiException as e:
        print(f"Error fetching MI status from Kubernetes API: {e.reason} (Status: {e.status})")
        # Return partial data or error structure
        return {
            "timestamp": current_timestamp,
            "error": f"Kubernetes API Error: {e.reason}",
            "active_pods": active_pods, # Might still have this from deployment status
            "total_cpu_millicores": total_cpu_millicores,
            "hpa_status": hpa_status_data,
            "deployment_status": deployment_status_data
        }
    except Exception as e:
        print(f"Unexpected error fetching MI status: {e}")
        import traceback
        traceback.print_exc()
        return {
            "timestamp": current_timestamp,
            "error": f"Unexpected error: {str(e)}",
            "active_pods": 0,
            "total_cpu_millicores": 0,
            "hpa_status": {},
            "deployment_status": {}
        }
    
    print(f"Status at {current_timestamp}: Active Pods: {active_pods}, Total CPU: {total_cpu_millicores:.2f}m")
    return {
        "timestamp": current_timestamp,
        "active_pods": active_pods,
        "total_cpu_millicores": round(total_cpu_millicores, 2),
        "hpa_status": hpa_status_data,
        "deployment_status": deployment_status_data,
        "error": None
    }
