# Dockerfile
FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    fastapi \
    uvicorn \
    httpx \
    duckduckgo-search \
    pydantic

COPY tools_server.py .

EXPOSE 8080

CMD ["uvicorn", "tools_server:app", "--host", "0.0.0.0", "--port", "8080"]