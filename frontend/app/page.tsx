// app/page.tsx
"use client";

import { useState, useEffect, ChangeEvent, FormEvent, useCallback } from 'react';
import StatusChart from '../components/StatusChart'; // Adjust path if needed

// Interfaces
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
  name: keyof DeploymentConfig | string;
  type?: string;
  value: string | number;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  min?: string | number;
  pattern?: string;
  title?: string;
  placeholder?: string;
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
  };
  deployment_status: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
  };
  error: string | null;
}

const MAX_CHART_DATA_POINTS = 30; // Show last 30 data points (e.g., 2.5 minutes if polling every 5s)

export default function HomePage() {
  const [config, setConfig] = useState<DeploymentConfig>({
    minReplicas: 1,
    maxReplicas: 5,
    cpuRequest: "250m",
    cpuLimit: "1",
    memoryRequest: "2Gi",
    memoryLimit: "2Gi",
    backendDelayMs: 0,
  });

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isDeploying, setIsDeploying] = useState<boolean>(false); // Separate state for deployment action
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [statusType, setStatusType] = useState<'success' | 'error' | ''>('');
  
  const [currentPods, setCurrentPods] = useState<number>(0);
  const [currentCpu, setCurrentCpu] = useState<number>(0);
  const [hpaDetails, setHpaDetails] = useState<ApiStatusResponse['hpa_status'] | null>(null);


  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const { name, value, type } = e.target;
    setConfig(prevConfig => ({
      ...prevConfig,
      [name]: type === 'number' ? parseInt(value, 10) || 0 : value,
    }));
  };

  const handleDeploy = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsDeploying(true); // Use isDeploying for the button
    setStatusMessage('');
    setStatusType('');
    console.log("Deployment configuration:", config);

    try {
      const response = await fetch('http://localhost:8000/api/deploy-mi', { // Ensure FastAPI is on port 8000
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || data.message || 'Deployment failed');
      }
      setStatusMessage(`Deployment successful! Message: ${data.message || 'MI instance is being configured.'}`);
      setStatusType('success');
      fetchStatus(); // Fetch status immediately after deploy
    } catch (error: any) {
      setStatusMessage(`Error: ${error.message}`);
      setStatusType('error');
      console.error("Deployment error:", error);
    } finally {
      setIsDeploying(false);
    }
  };

  const fetchStatus = useCallback(async () => {
    // setIsLoading(true); // Optional: show a global loader for status fetches
    try {
      const response = await fetch('http://localhost:8000/api/status');
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: "Failed to fetch status and parse error" }));
        throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
      }
      const data: ApiStatusResponse = await response.json();

      if (data.error) {
        console.warn("Error in status API response:", data.error);
        // Optionally set an error message for status fetching
        // setStatusMessage(`Status fetch warning: ${data.error}`);
        // setStatusType('error');
      }
      
      setCurrentPods(data.active_pods || 0);
      setCurrentCpu(data.total_cpu_millicores || 0);
      setHpaDetails(data.hpa_status || null);


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

    } catch (error: any) {
      console.error("Failed to fetch status:", error);
      // setStatusMessage(`Failed to fetch status: ${error.message}`);
      // setStatusType('error');
    } finally {
      // setIsLoading(false);
    }
  }, []); // Empty dependency array means this function is created once

  useEffect(() => {
    fetchStatus(); // Initial fetch
    const intervalId = setInterval(fetchStatus, 5000); // Poll every 5 seconds
    return () => clearInterval(intervalId); // Cleanup on unmount
  }, [fetchStatus]); // Rerun effect if fetchStatus changes (it won't due to useCallback)

  const InputField: React.FC<InputFieldProps> = ({ label, name, type = "text", value, onChange, min, pattern, title, placeholder }) => (
    <div>
      <label htmlFor={name as string} className="block text-sm font-medium text-slate-300 mb-1">{label}</label>
      <input
        type={type} name={name as string} id={name as string} value={value} onChange={onChange}
        min={min} pattern={pattern} title={title} placeholder={placeholder || label} required
        className="w-full bg-slate-700 border-slate-600 text-slate-100 rounded-md shadow-sm focus:ring-sky-500 focus:border-sky-500 py-2 px-3 transition-colors duration-150"
      />
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 py-8 px-4 sm:px-6 lg:px-8 text-slate-100 font-sans">
      <div className="max-w-5xl mx-auto"> {/* Increased max-width for more space */}
        <header className="mb-10 text-center">
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl bg-clip-text text-transparent bg-gradient-to-r from-sky-400 to-cyan-300">
            WSO2 MI Autoscaling Demo
          </h1>
          <p className="mt-3 text-lg text-slate-400">Configure, deploy, and monitor your Micro Integrator instance.</p>
        </header>

        {/* Form and Status Message Section */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-10">
          <form onSubmit={handleDeploy} className="lg:col-span-1 bg-slate-800 shadow-2xl rounded-xl p-6 space-y-6 h-fit">
            <div>
              <h2 className="text-xl font-semibold text-sky-400 border-b border-slate-700 pb-2 mb-4">
                Deployment Config
              </h2>
              <div className="space-y-4">
                <InputField label="Min Replicas" name="minReplicas" type="number" value={config.minReplicas} onChange={handleChange} min="1" />
                <InputField label="Max Replicas" name="maxReplicas" type="number" value={config.maxReplicas} onChange={handleChange} min="1" />
                <InputField label="CPU Request" name="cpuRequest" value={config.cpuRequest} onChange={handleChange} placeholder="250m"/>
                <InputField label="CPU Limit" name="cpuLimit" value={config.cpuLimit} onChange={handleChange} placeholder="1"/>
                <InputField label="Memory Request" name="memoryRequest" value={config.memoryRequest} onChange={handleChange} placeholder="2Gi"/>
                <InputField label="Memory Limit" name="memoryLimit" value={config.memoryLimit} onChange={handleChange} placeholder="2Gi"/>
                <InputField label="MI Delay (ms)" name="backendDelayMs" type="number" value={config.backendDelayMs} onChange={handleChange} min="0" />
              </div>
            </div>
            <div className="pt-4 border-t border-slate-700">
              <button type="submit" disabled={isDeploying}
                      className="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white 
                              bg-gradient-to-r from-sky-500 to-cyan-500 hover:from-sky-600 hover:to-cyan-600
                              focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 focus:ring-sky-500
                              disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 ease-in-out group">
                {isDeploying && (
                  <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                )}
                <span className="group-hover:scale-105 transition-transform duration-150">
                  {isDeploying ? 'Applying...' : 'Apply Configuration'}
                </span>
              </button>
            </div>
              {statusMessage && (
                <div className={`mt-6 p-3 rounded-md shadow-md text-sm ${statusType === 'success' ? 'bg-green-600/80 border border-green-500' : 'bg-red-600/80 border border-red-500'}`}>
                    <p className="whitespace-pre-wrap">{statusMessage}</p>
                </div>
            )}
          </form>

          {/* Live Status and Charts Section */}
          <div className="lg:col-span-2 space-y-8">
            <div className="bg-slate-800 shadow-2xl rounded-xl p-6">
                <h2 className="text-xl font-semibold text-sky-400 border-b border-slate-700 pb-2 mb-4">
                    Current MI Status
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                    <div className="bg-slate-700 p-3 rounded-md">
                        <p className="text-slate-400">Active Pods:</p>
                        <p className="text-sky-300 font-bold text-2xl">{currentPods}</p>
                    </div>
                    <div className="bg-slate-700 p-3 rounded-md">
                        <p className="text-slate-400">Total CPU (cores):</p>
                        <p className="text-sky-300 font-bold text-2xl">{(currentCpu / 1000).toFixed(2)}</p>
                    </div>
                      <div className="bg-slate-700 p-3 rounded-md">
                        <p className="text-slate-400">Desired Replicas (HPA):</p>
                        <p className="text-sky-300 font-bold text-2xl">{hpaDetails?.desiredReplicas ?? 'N/A'}</p>
                    </div>
                </div>
                  {hpaDetails?.lastScaleTime && (
                    <p className="text-xs text-slate-500 mt-3">HPA Last Scaled: {new Date(hpaDetails.lastScaleTime).toLocaleString()}</p>
                )}
            </div>

            <StatusChart 
              data={chartData} 
              metric="activePods" 
              title="Active Pods Over Time" 
              lineColor="#38bdf8" // sky-400
              yAxisLabel="Pods"
              yAxisDomain={[0, 'dataMax + 1']} // Ensure y-axis starts at 0 and has some padding
            />
            <StatusChart 
              data={chartData} 
              metric="totalCpuMillicores" 
              title="Total CPU Usage Over Time" 
              lineColor="#67e8f9" // cyan-300
              yAxisLabel="Millicores"
              yAxisDomain={[0, 'dataMax + 100']} // Ensure y-axis starts at 0 and has some padding
            />
          </div>
        </div>
      </div>
    </div>
  );
}
