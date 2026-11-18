import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localYaml = path.resolve(__dirname, 'openapi.yaml');
const srcYaml = path.resolve(__dirname, '../../src/docs/openapi.yaml');
const yamlPath = fs.existsSync(localYaml) ? localYaml : srcYaml;

const rawYaml = fs.readFileSync(yamlPath, 'utf-8');
const openapiDoc = YAML.parse(rawYaml) as Record<string, unknown>;

export const docsRouter = Router();

docsRouter.get('/openapi.yaml', (_req, res) => {
  res.type('application/yaml; charset=utf-8').send(rawYaml);
});

docsRouter.get('/openapi.json', (_req, res) => {
  res.json(openapiDoc);
});

docsRouter.use('/', swaggerUi.serve, swaggerUi.setup(openapiDoc, {
  customSiteTitle: 'Consul API v2.0.0 Docs',
}));
