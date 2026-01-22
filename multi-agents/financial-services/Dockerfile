FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    fastapi \
    uvicorn \
    pydantic

COPY financial_tools_server.py .

EXPOSE 8080

CMD ["uvicorn", "financial_tools_server:app", "--host", "0.0.0.0", "--port", "8080"]
