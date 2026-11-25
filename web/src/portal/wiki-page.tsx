import { CopyValue } from '@/components/copy-value';
import { BalanceIntegrationLab } from '@/pages/balance-integration-lab';
import { useState } from "react";
import { useSearchParams } from "react-router";
import { wikiTopics } from "./wiki-content";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { adminMountPath } from "@/admin-base";

export function PortalWiki(){
  const [query,setQuery]=useState(''),[search,setSearch]=useSearchParams();
  const topic=wikiTopics.find(item=>item.id===search.get('topic'))??wikiTopics[0]!;
  const filtered=wikiTopics.filter(item=>[item.title,item.summary,...item.sections.flatMap(section=>[section.title,...section.text])].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  function select(id:string){const next=new URLSearchParams(search);next.set('topic',id);setSearch(next);}
  return <section className="space-y-6" aria-label="支付功能Wiki"><header className="space-y-3"><h2 className="text-2xl font-semibold">StarPAY 功能 Wiki</h2><p className="text-sm leading-6 text-muted-foreground">从充值、收款、余额支付到年服务与对账，按功能查阅操作步骤。余额支付接口协议：v1。</p><Input aria-label="搜索功能文档" placeholder="搜索：充值、年费、退款、SDK…" value={query} onChange={event=>setQuery(event.target.value)}/></header>
    <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]"><nav aria-label="Wiki章节" className="space-y-1">{filtered.map(item=><Button key={item.id} className="min-h-11 w-full justify-start" variant={topic.id===item.id?'secondary':'ghost'} onClick={()=>select(item.id)} aria-current={topic.id===item.id?'page':undefined}>{item.title}</Button>)}{!filtered.length&&<p role="status" className="text-sm text-muted-foreground">没有匹配章节，试试其他关键词。</p>}</nav>
      <article className="min-w-0 space-y-6 rounded-lg border p-5 sm:p-7"><div><h3 className="text-xl font-semibold">{topic.title}</h3><p className="mt-2 text-sm text-muted-foreground">{topic.summary}</p></div>{topic.sections.map(section=><section key={section.title} className="space-y-3"><h4 className="font-semibold">{section.title}</h4>{section.text.map(text=><p key={text} className="text-sm leading-7">{text}</p>)}{section.steps&&<ol className="list-decimal space-y-2 pl-5 text-sm leading-6">{section.steps.map(text=><li key={text}>{text}</li>)}</ol>}{section.code&&<CopyValue value={section.code} label={`复制${section.title}示例`}/>}</section>)}
      {['balance','sdk'].includes(topic.id)&&<a className="inline-flex min-h-11 items-center text-sm font-medium underline" href={`${adminMountPath()}/epay/docs/balance-merchant-sdk.zip`} download>下载余额支付适配 SDK（含类型声明与说明）</a>}{topic.id==='sdk'&&<BalanceIntegrationLab/>}</article>
    </div>
  </section>;
}
