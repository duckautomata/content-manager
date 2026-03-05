# Stage 1: Build Environment
FROM golang:1.26-bookworm AS builder
ARG VIPS_VERSION=8.18.0

# 1. Install Build Dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    pkg-config \
    git \
    wget \
    meson \
    ninja-build \
    # Image Format Libraries
    libjpeg-dev \
    libpng-dev \
    libtiff-dev \
    libgif-dev \
    libwebp-dev \
    libxml2-dev \
    libfftw3-dev \
    liblcms2-dev \
    libexif-dev \
    libexpat1-dev \
    libglib2.0-dev \
    liborc-0.4-dev \
    ffmpeg \
    # AVIF / HEIC Dependencies
    libaom-dev \
    libde265-dev \
    libx265-dev \
    libheif-dev \
    && rm -rf /var/lib/apt/lists/*

# 2. Compile libvips from source
WORKDIR /tmp/vips
RUN wget https://github.com/libvips/libvips/releases/download/v${VIPS_VERSION}/vips-${VIPS_VERSION}.tar.xz \
    && tar xf vips-${VIPS_VERSION}.tar.xz \
    && cd vips-${VIPS_VERSION} \
    && meson setup build --prefix=/usr/local --buildtype=release \
       -Dheif=enabled \
       -Djpeg=enabled \
       -Dpng=enabled \
       -Dwebp=enabled \
       -Dintrospection=disabled \
    && cd build \
    && ninja \
    && ninja install \
    && ldconfig

# 3. Build the Go Application
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY main.go .
RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-s -w" -o server .


# Stage 2: Production Runtime
FROM debian:bookworm-slim

# 1. Install Runtime Dependencies
RUN apt-get update && apt-get install -y \
    libjpeg62-turbo \
    libpng16-16 \
    libtiff6 \
    libgif7 \
    libwebp7 \
    libwebpmux3 \
    libwebpdemux2 \
    libxml2 \
    libfftw3-bin \
    liblcms2-2 \
    libexif12 \
    libexpat1 \
    libglib2.0-0 \
    liborc-0.4-0 \
    libheif1 \
    libaom3 \
    libde265-0 \
    libx265-199 \
    ca-certificates \
    zip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 2. Copy compiled libvips libraries
COPY --from=builder /usr/local/lib /usr/local/lib

# 3. Update linker cache so the system finds our new libvips
RUN ldconfig

# 4. Copy Go binary
WORKDIR /root/
COPY --from=builder /app/server .

ENV PORT=8090
EXPOSE 8090
CMD ["./server"]
