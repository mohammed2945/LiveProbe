ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY python/sdk/src/liveprobe /opt/liveprobe-sdk/liveprobe
COPY evaluation/praxis/instrumentation/sitecustomize.py /opt/liveprobe-bootstrap/liveprobe_bootstrap.py
COPY evaluation/praxis/instrumentation/liveprobe_bootstrap.pth /opt/liveprobe-bootstrap/liveprobe_bootstrap.pth
RUN python -c "import shutil, site; shutil.copyfile('/opt/liveprobe-bootstrap/liveprobe_bootstrap.pth', site.getsitepackages()[0] + '/liveprobe_bootstrap.pth')"

ENV PYTHONPATH="/opt/liveprobe-bootstrap:/opt/liveprobe-sdk"
ENV LIVEPROBE_ENABLED="off"
ENV LIVEPROBE_SERVICE_ID="recommendation"
ENV LIVEPROBE_BROKER_URL="http://liveprobe-broker.otel-demo.svc.cluster.local:7070"
ENV LIVEPROBE_ENVIRONMENT="praxis-evaluation"
