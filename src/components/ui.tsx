'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Check, X, LoaderCircle, Split, AlertCircle } from 'lucide-react';
import { brand } from '@/lib/brand';

export function Logo({compact=false}:{compact?:boolean}) {return <span className="logo"><span className="logo-mark"><Split size={24} strokeWidth={2.7}/></span>{!compact&&<span>{brand.name}<span className="brand-dot">.</span></span>}</span>;}
export function Avatar({user,size='normal'}:{user?:{name?:string;avatarUrl?:string|null};size?:string}) {return <span className={`avatar avatar-${size}`} aria-label={user?.name}>{user?.avatarUrl?<img src={user.avatarUrl} alt="" referrerPolicy="no-referrer"/>:(user?.name||'?').split(' ').map(x=>x[0]).slice(0,2).join('')}</span>;}
export function Money({minor,currency='PKR'}:{minor:number;currency?:string}) {return <>{new Intl.NumberFormat('en',{style:'currency',currency,currencyDisplay:'code',minimumFractionDigits:2,maximumFractionDigits:2}).format((minor||0)/100)}</>;}
export function Spinner(){return <LoaderCircle size={18} className="spin" aria-label="Loading"/>;}
export function Empty({icon,title,description,action}:{icon?:React.ReactNode;title:string;description?:string;action?:React.ReactNode}) {return <div className="empty"><span className="empty-icon">{icon||<Split size={28}/>}</span><h3>{title}</h3><p>{description}</p>{action}</div>;}
export function Skeleton(){return <div className="skeleton-grid" aria-label="Loading your information" aria-busy="true">{[1,2,3,4,5,6].map(n=><div className="skeleton" key={n}/>)}</div>;}
const ToastContext=createContext<(message:string,error?:boolean)=>void>(()=>{});
export function ToastProvider({children}:{children:React.ReactNode}){
  const [toasts,setToasts]=useState<{id:number;message:string;error?:boolean}[]>([]);
  const notify=useCallback((message:string,error=false)=>{const id=Date.now()+Math.random();setToasts(x=>[...x,{id,message,error}]);setTimeout(()=>setToasts(x=>x.filter(t=>t.id!==id)),5000);},[]);
  return <ToastContext.Provider value={notify}>{children}<div className="toast-stack" role="status" aria-live="polite">{toasts.map(t=><div className={`toast ${t.error?'toast-error':''}`} key={t.id}>{t.error?<AlertCircle size={19}/>:<Check size={19}/>}<span>{t.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={()=>setToasts(x=>x.filter(v=>v.id!==t.id))}><X size={16}/></button></div>)}</div></ToastContext.Provider>;
}
export const useToast=()=>useContext(ToastContext);
export function Modal({title,children,onClose,wide=false}:{title:string;children:React.ReactNode;onClose:()=>void;wide?:boolean}){
  const dialog=useRef<HTMLDivElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement;const before=document.body.style.overflow;document.body.style.overflow='hidden';const element=dialog.current;element?.querySelector<HTMLElement>('input,button,select,textarea')?.focus();const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();if(e.key==='Tab'&&element){const items=Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,a[href]'));const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};document.addEventListener('keydown',onKey);return()=>{document.body.style.overflow=before;document.removeEventListener('keydown',onKey);previous?.focus();};},[onClose]);
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className={`modal ${wide?'modal-wide':''}`} ref={dialog} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-heading"><div><span className="eyebrow">A LITTLE LESS MATH</span><h2 id="modal-title">{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X/></button></div>{children}</div></div>;
}
export async function api<T=any>(url:string,options?:RequestInit):Promise<T>{const response=await fetch(url,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options?.headers}});const value=await response.json().catch(()=>({error:'Unable to reach the server.'}));if(!response.ok)throw new Error(typeof value.error==='string'?value.error:value.error?.message||value.message||'Something went wrong. Please try again.');return value;}
export function useData<T=any>(url:string){const [data,setData]=useState<T|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');const reload=useCallback(async()=>{setError('');try{setData(await api<T>(url));}catch(e){setError((e as Error).message);}finally{setLoading(false);}},[url]);useEffect(()=>{setLoading(true);void reload();},[reload]);return {data,loading,error,reload};}
export function ErrorState({message,retry}:{message:string;retry?:()=>void}){return <div className="error-state"><AlertCircle size={22}/><p>{message}</p>{retry&&<button className="button secondary" onClick={retry}>Try again</button>}</div>;}
