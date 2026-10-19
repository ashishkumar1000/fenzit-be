/**
 * R-15 (real HTTP): a DELETE with a JSON content-type and an empty body —
 * content-length 0 OR chunked — must reach the handler, while every other
 * empty/malformed JSON case keeps Fastify's 400.
 */
import { Body, Controller, Delete, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as http from 'http';
import { AddressInfo } from 'net';
import { FASTIFY_ROUTER_OPTIONS } from '../src/common/fastify-adapter-options';
import { allowBodilessDelete } from '../src/common/allow-bodiless-delete';

@Controller('probe')
class ProbeController {
  @Delete()
  del(@Body() body: unknown) {
    return { reached: true, body: body ?? null };
  }
  @Post()
  post(@Body() body: unknown) {
    return { reached: true, body };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

interface Res {
  status: number;
  json: Record<string, unknown>;
}

function send(
  port: number,
  method: string,
  headers: http.OutgoingHttpHeaders,
  chunks: string[] | null,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    // Node omits content-length for DELETE bodies (the body would then be
    // read as a second request), so declare it unless the test sets chunked.
    const h = { ...headers };
    if (
      chunks &&
      !h['transfer-encoding'] &&
      h['content-length'] === undefined
    ) {
      h['content-length'] = Buffer.byteLength(chunks.join(''));
    }
    const req = http.request(
      { host: '127.0.0.1', port, path: '/probe', method, headers: h },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            json: data ? (JSON.parse(data) as Record<string, unknown>) : {},
          }),
        );
      },
    );
    req.on('error', reject);
    for (const c of chunks ?? []) req.write(c);
    req.end();
  });
}

describe('allowBodilessDelete (e2e, real HTTP)', () => {
  let app: NestFastifyApplication;
  let port: number;
  const JSON_CT = { 'content-type': 'application/json' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ routerOptions: FASTIFY_ROUTER_OPTIONS }),
    );
    allowBodilessDelete(app.getHttpAdapter().getInstance());
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it('DELETE json + content-length 0 reaches the handler', async () => {
    const r = await send(
      port,
      'DELETE',
      { ...JSON_CT, 'content-length': 0 },
      null,
    );
    expect(r.status).toBe(200);
    expect(r.json.reached).toBe(true);
  });

  it('DELETE json + no content-length header reaches the handler', async () => {
    const r = await send(port, 'DELETE', JSON_CT, null);
    expect(r.status).toBe(200);
  });

  it('DELETE json + chunked empty body reaches the handler', async () => {
    const r = await send(
      port,
      'DELETE',
      { ...JSON_CT, 'transfer-encoding': 'chunked' },
      null,
    );
    expect(r.status).toBe(200);
    expect(r.json.reached).toBe(true);
  });

  it('DELETE with a real JSON body still parses (also chunked)', async () => {
    const a = await send(port, 'DELETE', JSON_CT, ['{"a":1}']);
    expect(a.json.body).toEqual({ a: 1 });
    const b = await send(
      port,
      'DELETE',
      { ...JSON_CT, 'transfer-encoding': 'chunked' },
      ['{"a"', ':2}'],
    );
    expect(b.json.body).toEqual({ a: 2 });
  });

  it('DELETE with malformed JSON is still 400', async () => {
    const r = await send(port, 'DELETE', JSON_CT, ['{bad']);
    expect(r.status).toBe(400);
  });

  it('POST with an empty JSON body is still 400', async () => {
    const a = await send(
      port,
      'POST',
      { ...JSON_CT, 'content-length': 0 },
      null,
    );
    expect(a.status).toBe(400);
    const b = await send(
      port,
      'POST',
      { ...JSON_CT, 'transfer-encoding': 'chunked' },
      null,
    );
    expect(b.status).toBe(400);
  });

  it('POST with malformed JSON is still 400', async () => {
    const r = await send(port, 'POST', JSON_CT, ['{bad']);
    expect(r.status).toBe(400);
  });

  it('POST with a __proto__ payload is still rejected (poisoning guard kept)', async () => {
    const r = await send(port, 'POST', JSON_CT, ['{"__proto__":{"x":1}}']);
    expect(r.status).toBe(400);
  });

  it('POST with a valid body parses', async () => {
    const r = await send(port, 'POST', JSON_CT, ['{"ok":true}']);
    expect(r.status).toBe(201);
    expect(r.json.body).toEqual({ ok: true });
  });
});
