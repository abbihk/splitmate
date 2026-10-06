import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { AppShell } from '@/components/app-shell';
export const dynamic='force-dynamic';
export default async function ProtectedLayout({children}:{children:React.ReactNode}){const user=await getCurrentUser();if(!user)redirect('/login');return <AppShell user={user}>{children}</AppShell>;}
