#!/bin/bash
export POSTER_KEY=$(tr -d '[:space:]' < /home/haodongtuo/.escrix_deploy_key)
export EXECUTOR_KEY=$(tr -d '[:space:]' < /home/haodongtuo/.escrix_executor_key)
export VERIFIER_KEY=escrix-verifier-2026
export API_URL=https://escrix-production.up.railway.app/v1
cd /home/haodongtuo/.openclaw/workspace/projects/escrix
node test_e2e.js
