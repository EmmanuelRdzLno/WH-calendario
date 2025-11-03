# Usa una imagen base de Node.js
FROM node:20

# Establece el directorio de trabajo
WORKDIR /app

# Copia archivos necesarios
COPY package*.json ./

# Instala las dependencias
RUN npm install

# Copia archivos restantes
COPY . .

# Crea carpeta para credenciales
RUN mkdir -p ./auth

# Variable de entorno del puerto
ENV PORT=8080

# Exponer el puerto del servidor web
EXPOSE 8080

# Comando para iniciar la app
CMD ["npm", "start"]
