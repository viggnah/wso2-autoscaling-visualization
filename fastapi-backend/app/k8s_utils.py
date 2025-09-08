# app/k8s_utils.py
from kubernetes import client, config as k8s_config
from kubernetes.client.rest import ApiException
from urllib3.exceptions import MaxRetryError, NewConnectionError # Import from urllib3
from .models import NextJSDeploymentConfig 
import datetime
import os

# --- Kubernetes Configuration ---
KUBE_CONFIG_LOADED = False
try:
    kubeconfig_path = os.getenv("KUBECONFIG")
    if kubeconfig_path:
        print(f"Attempting to load kubeconfig from KUBECONFIG env var: {kubeconfig_path}")
        k8s_config.load_kube_config(config_file=kubeconfig_path)
    else:
        print("KUBECONFIG env var not set, trying default kubeconfig path.")
        k8s_config.load_kube_config()
    KUBE_CONFIG_LOADED = True
    print("Successfully loaded kubeconfig for k8s_utils.")
except k8s_config.ConfigException as e1:
    print(f"Could not load kubeconfig: {e1}. Trying in-cluster config...")
    try:
        k8s_config.load_incluster_config()
        KUBE_CONFIG_LOADED = True
        print("Successfully loaded in-cluster config for k8s_utils.")
    except k8s_config.ConfigException as e2:
        print(f"Could not load in-cluster config: {e2}.")

if KUBE_CONFIG_LOADED:
    apps_v1_api = client.AppsV1Api()
    autoscaling_v2_api = client.AutoscalingV2Api()
    custom_objects_api = client.CustomObjectsApi()
else:
    apps_v1_api = None
    autoscaling_v2_api = None
    custom_objects_api = None
    print("WARNING: Kubernetes API clients not initialized due to config loading failure.")

# --- Constants ---
NAMESPACE = "default"
MI_DEPLOYMENT_NAME = "wso2mi-deployment"
MI_HPA_NAME = "wso2mi-hpa"
MI_CONTAINER_NAME = "wso2mi-container"
MI_APP_LABEL = "wso2mi"
# The environment variable name that your WSO2 MI Synapse configuration reads for the delay
MI_EXPECTED_DELAY_ENV_VAR = "BACKEND_DELAY"

async def apply_mi_configuration(payload: NextJSDeploymentConfig) -> dict:
    if not KUBE_CONFIG_LOADED or not apps_v1_api or not autoscaling_v2_api:
        raise ValueError("Kubernetes client not initialized. Check K8s configuration.")

    deployment_details = {}
    hpa_details = {}

    try:
        current_deployment = apps_v1_api.read_namespaced_deployment(name=MI_DEPLOYMENT_NAME, namespace=NAMESPACE)
        
        if current_deployment.spec.template.spec.containers:
            for container in current_deployment.spec.template.spec.containers:
                if container.name == MI_CONTAINER_NAME:
                    container.resources.requests = {"cpu": payload.cpuRequest, "memory": payload.memoryRequest}
                    container.resources.limits = {"cpu": payload.cpuLimit, "memory": payload.memoryLimit}
                    
                    env_var_exists = False
                    if container.env:
                        for env_var in container.env:
                            if env_var.name == MI_EXPECTED_DELAY_ENV_VAR: # Use the defined constant
                                env_var.value = str(payload.backendDelayMs)
                                env_var_exists = True
                                break
                        if not env_var_exists:
                            container.env.append(client.V1EnvVar(name=MI_EXPECTED_DELAY_ENV_VAR, value=str(payload.backendDelayMs)))
                    else:
                        container.env = [client.V1EnvVar(name=MI_EXPECTED_DELAY_ENV_VAR, value=str(payload.backendDelayMs))]
                    break 
        
        apps_v1_api.patch_namespaced_deployment(name=MI_DEPLOYMENT_NAME, namespace=NAMESPACE, body=current_deployment)
        deployment_details = {"status": "patched", "name": MI_DEPLOYMENT_NAME}
        print(f"Patched Deployment '{MI_DEPLOYMENT_NAME}'.")

    except ApiException as e:
        if e.status == 404:
            raise ValueError(f"MI Deployment '{MI_DEPLOYMENT_NAME}' not found.") from e
        raise ValueError(f"Error patching MI Deployment: {e.reason}") from e
    except (MaxRetryError, NewConnectionError) as e:
        print(f"K8s API connection error during MI Deployment patch: {e}")
        raise ValueError(f"Kubernetes API connection failed: {str(e)}") from e
    except Exception as e:
        print(f"Unexpected error during MI Deployment configuration: {e}")
        raise ValueError(f"Unexpected error configuring MI Deployment: {str(e)}") from e

    try:
        current_hpa = autoscaling_v2_api.read_namespaced_horizontal_pod_autoscaler(name=MI_HPA_NAME, namespace=NAMESPACE)
        current_hpa.spec.min_replicas = payload.minReplicas
        current_hpa.spec.max_replicas = payload.maxReplicas
        autoscaling_v2_api.patch_namespaced_horizontal_pod_autoscaler(name=MI_HPA_NAME, namespace=NAMESPACE, body=current_hpa)
        hpa_details = {"status": "patched", "name": MI_HPA_NAME}
        print(f"Patched HPA '{MI_HPA_NAME}'.")

    except ApiException as e:
        if e.status == 404:
            raise ValueError(f"MI HPA '{MI_HPA_NAME}' not found.") from e
        raise ValueError(f"Error patching HPA: {e.reason}") from e
    except (MaxRetryError, NewConnectionError) as e:
        print(f"K8s API connection error during HPA patch: {e}")
        raise ValueError(f"Kubernetes API connection failed: {str(e)}") from e
    except Exception as e:
        print(f"Unexpected error during HPA configuration: {e}")
        raise ValueError(f"Unexpected error configuring HPA: {str(e)}") from e
            
    return {"deployment": deployment_details, "hpa": hpa_details}

def parse_cpu_value(cpu_str: str) -> float:
    if not cpu_str: return 0.0
    if cpu_str.endswith('m'): return float(cpu_str[:-1])
    if cpu_str.endswith('n'): return float(cpu_str[:-1]) / 1_000_000
    try: return float(cpu_str) * 1000
    except ValueError: return 0.0

async def get_mi_status():
    current_timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    default_error_status = {
        "timestamp": current_timestamp, "error": "Initial error state or K8s client not ready.",
        "active_pods": 0, "total_cpu_millicores": 0,
        "hpa_status": {"error": "Not fetched"}, "deployment_status": {"error": "Not fetched"}
    }
    
    if not KUBE_CONFIG_LOADED or not all([apps_v1_api, autoscaling_v2_api, custom_objects_api]):
        print("get_mi_status: Kubernetes client not initialized. Returning error status.")
        default_error_status["error"] = "Kubernetes client not initialized on backend. Check K8s configuration and connection."
        return default_error_status

    active_pods = 0
    total_cpu_millicores = 0.0
    hpa_status_data = {"error": None}
    deployment_status_data = {"error": None}
    metrics_error_message = None # Specific message for metrics part

    try:
        try:
            deployment = apps_v1_api.read_namespaced_deployment_status(name=MI_DEPLOYMENT_NAME, namespace=NAMESPACE)
            active_pods = deployment.status.ready_replicas if deployment.status.ready_replicas is not None else 0
            deployment_status_data.update({
                "replicas": deployment.status.replicas if deployment.status.replicas is not None else 0,
                "readyReplicas": active_pods,
                "availableReplicas": deployment.status.available_replicas if deployment.status.available_replicas is not None else 0,
                "updatedReplicas": deployment.status.updated_replicas if deployment.status.updated_replicas is not None else 0,
            })
        except ApiException as e:
            active_pods = 0 
            if e.status == 404:
                deployment_status_data["error"] = f"MI Deployment '{MI_DEPLOYMENT_NAME}' not found."
            else:
                deployment_status_data["error"] = f"K8s API Error (Deployment): {e.reason} (Status: {e.status})"
            print(deployment_status_data["error"])
        
        try:
            hpa_spec = autoscaling_v2_api.read_namespaced_horizontal_pod_autoscaler(name=MI_HPA_NAME, namespace=NAMESPACE)
            hpa_status = autoscaling_v2_api.read_namespaced_horizontal_pod_autoscaler_status(name=MI_HPA_NAME, namespace=NAMESPACE)
            hpa_status_data.update({
                "minReplicas": hpa_spec.spec.min_replicas,
                "maxReplicas": hpa_spec.spec.max_replicas,
                "currentReplicas": hpa_status.status.current_replicas if hpa_status.status and hpa_status.status.current_replicas is not None else 0,
                "desiredReplicas": hpa_status.status.desired_replicas if hpa_status.status and hpa_status.status.desired_replicas is not None else 0,
                "lastScaleTime": hpa_status.status.last_scale_time.isoformat() if hpa_status.status and hpa_status.status.last_scale_time else None,
            })
        except ApiException as e:
            if e.status == 404:
                hpa_status_data["error"] = f"MI HPA '{MI_HPA_NAME}' not found."
            else:
                hpa_status_data["error"] = f"K8s API Error (HPA): {e.reason} (Status: {e.status})"
            print(hpa_status_data["error"])

        if not deployment_status_data.get("error") and active_pods > 0:
            try:
                pod_metrics_list = custom_objects_api.list_namespaced_custom_object(
                    group="metrics.k8s.io", version="v1beta1",
                    namespace=NAMESPACE, plural="pods", label_selector=f"app={MI_APP_LABEL}"
                )
                for item in pod_metrics_list.get("items", []):
                    for container_metrics in item.get("containers", []):
                        if container_metrics.get("name") == MI_CONTAINER_NAME:
                            cpu_usage_str = container_metrics.get("usage", {}).get("cpu", "0n")
                            total_cpu_millicores += parse_cpu_value(cpu_usage_str)
                            break 
            except ApiException as e:
                if e.status == 404:
                     metrics_error_message = "Pod metrics not found. Ensure Metrics Server is running and MI pods are up with correct labels."
                else:
                    metrics_error_message = f"K8s API Error (PodMetrics): {e.reason} (Status: {e.status})."
                print(metrics_error_message)
        elif active_pods == 0 and not deployment_status_data.get("error"):
             metrics_error_message = "No active MI pods to fetch metrics from."


    # Catch specific connection errors from urllib3, which are wrapped by kubernetes.client.exceptions.ApiException
    # but sometimes can be raised directly if the API client fails at a very low level.
    except (MaxRetryError, NewConnectionError) as e:
        error_msg = f"Kubernetes API connection failed: {type(e).__name__} - {str(e)}. Check K8s cluster reachability."
        print(error_msg)
        default_error_status["error"] = error_msg
        return default_error_status
    except ApiException as e: # Catch K8s API exceptions not handled by specific resource try-excepts
        error_msg = f"Kubernetes API call failed: {e.reason} (Status: {e.status})"
        print(error_msg)
        default_error_status["error"] = error_msg
        return default_error_status
    except Exception as e:
        import traceback
        error_msg = f"Unexpected backend error in get_mi_status: {str(e)}"
        print(error_msg)
        traceback.print_exc()
        default_error_status["error"] = error_msg
        return default_error_status
    
    # Consolidate error messages for the final response
    all_errors = [
        deployment_status_data.get("error"), 
        hpa_status_data.get("error"), 
        metrics_error_message
    ]
    final_error_summary = "; ".join(filter(None, all_errors)) or None

    response_data = {
        "timestamp": current_timestamp,
        "active_pods": active_pods,
        "total_cpu_millicores": round(total_cpu_millicores, 2),
        "hpa_status": hpa_status_data,
        "deployment_status": deployment_status_data,
        "error": final_error_summary
    }
    print(f"Status at {current_timestamp}: Active Pods: {active_pods}, CPU: {total_cpu_millicores:.2f}m. Error: {final_error_summary}")
    return response_data
