#!/bin/bash
set -e
PK=$(cat /home/haodongtuo/.escrix_deploy_key)
TREASURY=0x448711566BdCB88CAd6519B684a328441f5B583b
USDC_SEPOLIA=0x036CbD53842c5426634e7929541eC2318f3dCF7e

/home/haodongtuo/.foundry/bin/forge create \
  /home/haodongtuo/.openclaw/workspace/projects/escrix/contracts/src/EscrixEscrow.sol:EscrixEscrow \
  --rpc-url https://sepolia.base.org \
  --private-key "***" \
  --constructor-args "$TREASURY" "$USDC_SEPOLIA" \
  --broadcast 2>&1
