const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Restaurant SaaS API",
      version: "1.0.0",
      description: "API documentation for Restaurant SaaS"
    },
    servers: [
      {
        url: "http://localhost:5000/api",
      }
    ]
  },
  apis: ["./routes/*.js"], // swagger scans route files
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;