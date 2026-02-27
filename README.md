# content-manager-system
A simple python and go server that manages content in an object storage bucket and optimize images before being uploaded.

## Overview

_System_

- **[Content Manager](#content-manager)**
- **[Image Converter](#webp-converter)**

_Development_

- **[Tech Used](#tech-used)**
- **[Requirements](#requirements)**
- **[Running Source Code](#running-source-code)**

_Docker_
- **[Host Requirements](#host-requirements)**
- **[Version Guide](#version-guide)**
- **[Running with Docker](#running-with-docker)**

## System

### Content Manager

The content manager is the python part of the codebase. It is used to view, manage, upload, and delete files in an object storage bucket.

Its main part is the web interface. Here you can drag and drop files in, and set what prefix you want to work in.

### Image Converter

The image converter is the golang part of the codebase located under the [webp/](/webp/) folder. It is used to extract info from the image and convert any image to webp.

This will only be called if the uploaded file is an image.

## Development

### Tech Used (content manager only)
- Python 1.12

### Requirements
- Python
- A running instance of webp-converter
- Object Storage bucket. S3 or R2.
- Any OS

### Running Source Code

**NOTE**: This is only required to run the source code. If you only want to run it and not develop it, then check out the [Docker section](#docker)

1. **Create the environment file**:
   ```bash
   cp .env.example .env
   ```
   And fill in your environment values.

2. **Create and activate a virtual environment**:
   ```bash
   python -m venv .venv
   
   # Windows
   .\.venv\Scripts\activate
   
   # macOS/Linux
   source .venv/bin/activate
   ```

3. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Run the FastAPI development server**:
   ```bash
   uvicorn main:app --reload --port 8000
   ```

The application UI will be available at [http://127.0.0.1:8000/](http://127.0.0.1:8000/).

## Docker

### Host Requirements
- Any OS
- Docker and Docker Compose

If it has Docker, it can run this.

You can view the image on Dockerhub:
- [content-manager](https://hub.docker.com/r/duckautomata/content-manager)
- [webp-converter](https://hub.docker.com/r/duckautomata/webp-converter)

### Running with Docker
The easiest way to run the docker image is to
1. copy [docker-compose.yml](./docker-compose.yml) and create an `.env` file in a folder where you want to run it.
2. Ensure your `.env` file is properly configured.
3. Start the containers:
   ```bash
   docker compose up -d
   ```
4. Stop the container:
   ```bash
   docker compose down
   ```
   
The application will be available at http://<server-address>:8000
The webp-converter will be available at http://<server-address>:8090

### Building new image
To build a new image with the latest tag, run
```bash
./build.sh
```
