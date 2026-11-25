import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, type AddressInfo } from 'node:net';
import { it } from 'node:test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

it('keeps wildcard admission middleware on encoded line terminators and overlapping admin routes', async () => {
  const app=new Hono();
  app.use('*',async(c,next)=>{c.header('x-admission-checked','yes');await next();});
  app.use('/admin/*',async c=>c.text('authorization required',401));
  app.get('/admin*',c=>c.text('protected'));
  app.notFound(c=>c.text('not found',404));
  assert.equal((await app.request('/admin/secrets')).status,401);
  for(const path of ['/unknown/%0A','/unknown/%0D','/unknown/%E2%80%A8','/unknown/%E2%80%A9']){
    const response=await app.request(path);
    assert.equal(response.headers.get('x-admission-checked'),'yes',path);
    assert.equal(response.status,404);
  }
});

it('rejects raw backslashes before the Node adapter can rewrite a proxy-protected path',async()=>{
  const paths:string[]=[];
  const app=new Hono().all('*',c=>{paths.push(c.req.path);return c.text('synthetic route');});
  const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
  await once(server,'listening');
  const address=server.address() as AddressInfo;
  async function rawRequest(path:string){
    const socket=createConnection({host:'127.0.0.1',port:address.port});let reply='';
    socket.setTimeout(3000,()=>socket.destroy(new Error('local security probe timed out')));
    socket.setEncoding('utf8');socket.on('data',chunk=>{reply+=chunk;});
    await once(socket,'connect');
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    await once(socket,'end');socket.destroy();return reply;
  }
  try{
    for(const path of ['/public\\..\\admin/secrets','/admin\\secrets'])assert.match(await rawRequest(path),/^HTTP\/1.1 400 /);
    assert.equal(paths.length,0);
    assert.match(await rawRequest('/public?literal=back\\slash'),/^HTTP\/1.1 200 /);
    assert.deepEqual(paths,['/public']);
  }finally{if('closeAllConnections' in server)server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
