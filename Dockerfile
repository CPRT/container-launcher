# Use an official Node.js runtime as a parent image
FROM node:20-alpine

# Set work directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy rest of the source code
COPY src ./src
COPY tsconfig.json ./

RUN npm run build

# Expose default SSR port
EXPOSE 8080

# Start the SSR app
CMD ["npm", "run", "start"]
