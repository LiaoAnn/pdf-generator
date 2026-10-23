#!/bin/bash

# require `socat` to be installed

echo "Starting localhost->::1 tunnel..."
socat TCP4-LISTEN:8976,fork TCP6:[::1]:8976 &
tunnel_proc=$!

npx wrangler login

kill $tunnel_proc
