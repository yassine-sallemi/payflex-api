FROM node:24-alpine
RUN apk add --no-cache unzip
WORKDIR /app
COPY exporter.js .
USER node
EXPOSE 9300
CMD ["node", "exporter.js"]
