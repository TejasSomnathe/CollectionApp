import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
    })
  : null

export type UserRole = 'admin' | 'collector'

export interface Profile {
  id: string
  display_name: string
  role: UserRole
  active: boolean
}

export interface Customer {
  id: string
  customer_code: string
  full_name: string
  phone: string | null
  address: string | null
  collector_id: string
  status: 'active' | 'inactive'
}

export interface CollectionEntry {
  id: string
  receipt_number: string
  customer_id: string
  collector_id: string
  amount_paise: number | string
  collected_at: string
  payment_method: 'cash' | 'upi' | 'bank_transfer' | 'other'
  notes: string | null
  status: 'posted' | 'reversed'
  created_by: string
  created_at: string
  customers?: Pick<Customer, 'full_name' | 'customer_code'> | null
  collector?: Pick<Profile, 'display_name'> | null
}
