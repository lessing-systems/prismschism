# Build stage
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
# go.sum is generated during build (repo has no vendored deps yet)
COPY . .
RUN go mod tidy && CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/scraper .

# Runtime stage
FROM alpine:3.20
RUN adduser -D -u 10001 scraper
COPY --from=build /out/scraper /usr/local/bin/scraper
USER scraper
ENTRYPOINT ["/usr/local/bin/scraper"]
