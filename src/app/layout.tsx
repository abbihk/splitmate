import type { Metadata } from 'next';
import './globals.css';
import { brand } from '@/lib/brand';
export const metadata: Metadata = {title:{default:brand.name,template:`%s · ${brand.name}`},description:'Share expenses, see what you owe, and settle up with friends. Every little thing, shared fairly.'};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="en"><body>{children}</body></html>;}
