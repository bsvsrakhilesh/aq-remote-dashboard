# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN groupadd --system --gid 10001 axiom \
    && useradd --system --uid 10001 --gid axiom --home-dir /nonexistent axiom \
    && mkdir -p /data/input /data/state \
    && chown -R axiom:axiom /data/state

COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --requirement /tmp/requirements.txt

COPY --chown=axiom:axiom backend /app/backend

USER axiom
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD python -c "import http.client; c=http.client.HTTPConnection('::1',8000,timeout=3); c.request('GET','/api/health'); raise SystemExit(0 if c.getresponse().status == 200 else 1)"

CMD ["uvicorn", "backend.app.main:app", "--host", "::", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
