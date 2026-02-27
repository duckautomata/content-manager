#!/bin/bash

# A script to build and tag Docker images using the latest tag.
#
# Usage: ./build.sh

# --- Configuration ---
IMAGE_NAME="duckautomata/webp-converter"
LATEST_TAG="${IMAGE_NAME}:latest"
# ---------------------

echo "-----------------------------------"

# --- Docker Command ---
# Check if the user can run docker without sudo
if command -v docker &> /dev/null && docker info > /dev/null 2>&1; then
    DOCKER_CMD="docker"
elif command -v sudo &> /dev/null && sudo docker info > /dev/null 2>&1; then
    DOCKER_CMD="sudo docker"
else
    echo "Error: Docker is not running or you lack permission to use it."
    exit 1
fi

echo "Building Docker image..."
if ! $DOCKER_CMD build -t $LATEST_TAG .; then
    echo "Docker build failed. Aborting."
    exit 1
fi

echo -e "\nBuild successful. Created images:"
$DOCKER_CMD images --filter=reference="${IMAGE_NAME}"

# --- Optional Push to Registry ---
read -p "Push latest image to the registry? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo " Pushing ${LATEST_TAG}..."
    $DOCKER_CMD push "${LATEST_TAG}"
    echo "Push complete."
fi
