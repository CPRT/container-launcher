#!/bin/bash

echo "Starting the container launcher..."

docker run -it --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    cprtsoftware/container-launcher:latest