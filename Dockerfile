FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY flightmon ./flightmon
COPY wsgi.py .
# config.toml, .env, travelers.toml and data/ are mounted at runtime (see DEPLOY.md)
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
# ONE worker on purpose: the search loop lives in the worker process.
CMD ["gunicorn", "-w", "1", "--threads", "4", "-b", "0.0.0.0:8080", "--timeout", "60", "wsgi:app"]
