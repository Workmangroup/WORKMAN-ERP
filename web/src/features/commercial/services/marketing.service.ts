import { createClient } from '@/lib/supabase/server'

export interface MarketingTemplate { id: string; channel: 'email' | 'sms' | 'whatsapp'; name: string; subject: string | null; status: 'draft' | 'approved'; created_by: string | null; approved_at: string | null }
export interface MarketingSegment { id: string; name: string; channel: string; country: string | null; client_ids: string[] | null }
export interface MarketingCampaign { id: string; name: string; channel: string; status: 'draft' | 'prepared' | 'cancelled'; template_id: string; segment_id: string; prepared_at: string | null }
export interface CampaignSummary {
  campaign_id: string; name: string; channel: string; status: string; eligible: number
  excluded: Record<string, number>; unit_price: number | null; currency: string | null; estimated_cost: number | null; events: Record<string, number>
}
export interface MarketingPolicy { send_enabled: boolean; enabled_channels: string[]; connector: string | null }

/** Lecture marketing (marketing.read) : chaque ligne passe par la RLS ; les résumés sont calculés par la base. */
export async function marketingOverview() {
  const supabase = await createClient()
  const [policy, templates, segments, campaigns, prices] = await Promise.all([
    supabase.from('marketing_policy').select('send_enabled,enabled_channels,connector').maybeSingle(),
    supabase.from('marketing_templates').select('id,channel,name,subject,status,created_by,approved_at').order('created_at', { ascending: false }).limit(200),
    supabase.from('marketing_segments').select('id,name,channel,country,client_ids').order('created_at', { ascending: false }).limit(200),
    supabase.from('marketing_campaigns').select('id,name,channel,status,template_id,segment_id,prepared_at').order('created_at', { ascending: false }).limit(200),
    supabase.from('marketing_channel_prices').select('channel,currency,unit_price,set_at').order('set_at', { ascending: false }).limit(50),
  ])
  const list = (campaigns.data ?? []) as MarketingCampaign[]
  const summaries = await Promise.all(list.map((c) => supabase.rpc('marketing_campaign_summary', { p_campaign: c.id })))
  return {
    policy: (policy.data ?? null) as MarketingPolicy | null,
    templates: (templates.data ?? []) as MarketingTemplate[],
    segments: (segments.data ?? []) as MarketingSegment[],
    campaigns: list,
    summaries: summaries.flatMap(({ data, error }) => (error || !data ? [] : [data as CampaignSummary])),
    prices: (prices.data ?? []) as { channel: string; currency: string; unit_price: number; set_at: string }[],
  }
}
