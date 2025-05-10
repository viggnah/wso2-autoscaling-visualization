FROM wso2/wso2mi:4.4.0-rocky

# Copy the CAR file to the Micro Integrator's carbonapps deployment directory
COPY --chown=wso2carbon:wso2carbon PassthroughAPI_1.0.0.car /home/wso2carbon/wso2mi-4.4.0/repository/deployment/server/carbonapps/

# Expose standard MI ports (already exposed by base image, but good for documentation)
EXPOSE 8290 8253 9164

# The base image's entrypoint will start WSO2 MI.
# No need to override CMD or ENTRYPOINT unless you have specific startup needs.
