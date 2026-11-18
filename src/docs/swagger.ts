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
