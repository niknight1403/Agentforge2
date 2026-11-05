FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends cargo rustc python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*
