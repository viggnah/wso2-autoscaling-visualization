# app/models.py
from pydantic import BaseModel, Field

class MIResourceConfig(BaseModel):
    cpu_request: str = Field(..., alias="cpuRequest", example="250m", description="CPU request for MI pod, e.g., '250m', '1'")
    cpu_limit: str = Field(..., alias="cpuLimit", example="1", description="CPU limit for MI pod, e.g., '500m', '2'")
    memory_request: str = Field(..., alias="memoryRequest", example="2Gi", description="Memory request for MI pod, e.g., '512Mi', '2Gi'")
    memory_limit: str = Field(..., alias="memoryLimit", example="2Gi", description="Memory limit for MI pod, e.g., '1Gi', '4Gi'")

class MIHPAConfig(BaseModel):
    min_replicas: int = Field(..., alias="minReplicas", ge=1, example=1, description="Minimum number of MI replicas for HPA")
    max_replicas: int = Field(..., alias="maxReplicas", ge=1, example=5, description="Maximum number of MI replicas for HPA")

    # Validator to ensure max_replicas is not less than min_replicas could be added here if needed
    # from pydantic import validator
    # @validator('max_replicas')
    # def max_must_be_ge_min(cls, v, values):
    #     if 'min_replicas' in values and v < values['min_replicas']:
    #         raise ValueError('maxReplicas must be greater than or equal to minReplicas')
    #     return v

class MIDeploymentPayload(BaseModel):
    hpa_config: MIHPAConfig = Field(..., alias="hpaConfig")
    resource_config: MIResourceConfig = Field(..., alias="resourceConfig")
    backend_delay: int = Field(..., alias="backendDelay", ge=0, example=0, description="Simulated backend delay for MI in milliseconds")
    
    # This model will be nested in the main payload from Next.js
    # The Next.js payload sends minReplicas, maxReplicas, etc. at the top level.
    # We'll map them in the endpoint. For now, let's define a direct payload model
    # that matches the structure of the 'config' object from Next.js.

class NextJSDeploymentConfig(BaseModel):
    minReplicas: int = Field(..., ge=1)
    maxReplicas: int = Field(..., ge=1)
    cpuRequest: str
    cpuLimit: str
    memoryRequest: str
    memoryLimit: str
    backendDelayMs: int = Field(..., ge=0)

class DeploymentResponse(BaseModel):
    message: str
    details: dict = {}

class K6Stage(BaseModel):
    duration: str = Field(..., example="1m", description="Duration of the stage (e.g., '30s', '1m', '1h')")
    target: int = Field(..., ge=0, example=10, description="Target number of virtual users for this stage")

class K6ConfigPayload(BaseModel):
    target_url: str = Field(..., alias="targetURL", example="http://localhost:8290/echo", description="Target URL for the k6 test")
    stages_json: str = Field(..., alias="stagesJSON", example='[{"duration": "1m", "target": 10}]', description="JSON string representing k6 stages array")
    # We'll parse stages_json into List[K6Stage] in the endpoint or a utility function.

class K6TestStatusResponse(BaseModel):
    is_running: bool
    message: str
    pid: int | None = None # Process ID of the k6 test
