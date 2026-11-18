import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidatePaths = [
  path.join(process.cwd(), 'src/docs/openapi.yaml'),
  path.resolve(__dirname, 'openapi.yaml'),
  path.resolve(__dirname, '../../src/docs/openapi.yaml'),
];
const yamlPath = candidatePaths.find((p) => fs.existsSync(p));

const rawYaml = yamlPath
  ? fs.readFileSync(yamlPath, 'utf-8')
  : 'openapi: 3.0.3\ninfo:\n  title: Consul API\n  version: 2.0.0\npaths: {}\n';
const openapiDoc = YAML.parse(rawYaml) as Record<string, unknown>;

const SWAGGER_HTML_VERCEL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Consul API v2.0.0 Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: '/api/docs/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout'
      });
    };
  </script>
</body>
</html>`;

export const docsRouter = Router();

docsRouter.get('/openapi.yaml', (_req, res) => {
  res.type('application/yaml; charset=utf-8').send(rawYaml);
});

docsRouter.get('/openapi.json', (_req, res) => {
  res.json(openapiDoc);
});

if (process.env.VERCEL) {
  docsRouter.get('/', (_req, res) => {
    res.type('text/html; charset=utf-8').send(SWAGGER_HTML_VERCEL);
  });
} else {
  docsRouter.use(
    '/',
    swaggerUi.serve,
    swaggerUi.setup(openapiDoc, {
      customSiteTitle: 'Consul API v2.0.0 Docs',
    }),
  );
}
