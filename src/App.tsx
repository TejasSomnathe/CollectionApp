import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { FunctionsHttpError, type Session } from '@supabase/supabase-js'
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BadgeIndianRupee,
  Banknote,
  BriefcaseBusiness,
  Check,
  CircleAlert,
  Clock3,
  FileSpreadsheet,
  Filter,
  History,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  MoreHorizontal,
  Plus,
  Printer,
  ReceiptText,
  Search,
  Settings2,
  ShieldCheck,
  Smartphone,
  Users,
  WalletCards,
  X,
} from 'lucide-react'
import {
  escapeCsvCell,
  formatINR,
  formatIndiaDate,
  indiaDateTimeInput,
  indiaTimestamp,
  parseRupeesToPaise,
} from './lib/finance'
import {
  isSupabaseConfigured,
  supabase,
  type CollectionEntry,
  type Customer,
  type Profile,
  type UserRole,
} from './lib/supabase'

type View = 'overview' | 'collect' | 'collections' | 'customers' | 'reports' | 'team' | 'settings'
type Summary = {
  today_total_paise: number | string
  today_count: number
  cash_total_paise: number | string
  digital_total_paise: number | string
}
type AuditItem = {
  id: string
  action: string
  reason: string
  actor_id: string
  created_at: string
}
type CollectionReport = {
  summary: {
    net_total_paise: string | number
    posted_count: number
    cash_total_paise: string | number
    digital_total_paise: string | number
    reversed_count: number
  }
  collectors: {
    collector_id: string
    display_name: string
    total_paise: string | number
    transaction_count: number
  }[]
  customers: {
    customer_id: string
    customer_code: string
    full_name: string
    total_paise: string | number
    transaction_count: number
  }[]
}
const zeroSummary: Summary = {
  today_total_paise: 0,
  today_count: 0,
  cash_total_paise: 0,
  digital_total_paise: 0,
}
const nav: Record<UserRole, [View, string, typeof LayoutDashboard][]> = {
  admin: [
    ['overview', 'Overview', LayoutDashboard],
    ['collections', 'Collections', ReceiptText],
    ['customers', 'Customers', Users],
    ['reports', 'Reports', FileSpreadsheet],
    ['team', 'Collectors', BriefcaseBusiness],
    ['settings', 'Business settings', Settings2],
  ],
  collector: [
    ['overview', 'Overview', LayoutDashboard],
    ['collect', 'Quick collection', Plus],
    ['customers', 'Customers', Users],
    ['collections', 'My history', History],
  ],
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(!isSupabaseConfigured)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [view, setView] = useState<View>('overview')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [entries, setEntries] = useState<CollectionEntry[]>([])
  const [collectors, setCollectors] = useState<Profile[]>([])
  const [summary, setSummary] = useState(zeroSummary)
  const [reportData, setReportData] = useState<CollectionReport | null>(null)
  const [businessName, setBusinessName] = useState('Daily Collection Pro')
  const [receiptPrefix, setReceiptPrefix] = useState('DCP')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [authError, setAuthError] = useState('')
  const [selected, setSelected] = useState<CollectionEntry | null>(null)
  const [audit, setAudit] = useState<AuditItem[]>([])
  const [customerDetail, setCustomerDetail] = useState<Customer | null>(null)
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(0)
  const [count, setCount] = useState(0)
  const [collectorFilter, setCollectorFilter] = useState('')
  const [customerFilter, setCustomerFilter] = useState('')
  const [methodFilter, setMethodFilter] = useState('')
  const [customerPayments, setCustomerPayments] = useState<CollectionEntry[]>([])
  const [online, setOnline] = useState(navigator.onLine)

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      if (!next) setProfile(null)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    return () => {
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
    }
  }, [])

  useEffect(() => {
    if (!session?.user.id || !supabase) return
    const client = supabase
    let cancelled = false
    void client
      .from('profiles')
      .select('id,display_name,role,active')
      .eq('id', session.user.id)
      .single()
      .then(async ({ data, error: profileError }) => {
        if (cancelled) return
        if (profileError || !data?.active) {
          setAuthError(
            data?.active === false
              ? 'This account is inactive. Contact an administrator.'
              : profileError?.code === 'PGRST116'
                ? 'This Auth account has no profile yet. Ask the project owner to apply the profile backfill migration.'
              : (profileError?.message ?? 'Profile unavailable.'),
          )
          await client.auth.signOut()
          return
        }
        setAuthError('')
        setProfile(data as Profile)
      })
    return () => {
      cancelled = true
    }
  }, [session])

  const loadData = useCallback(async () => {
    if (!supabase || !profile) return
    setLoading(true)
    setError('')
    const [c, e, s, settings] = await Promise.all([
      supabase.from('customers').select('*').order('full_name').limit(1000),
      supabase
        .from('collection_entries')
        .select('*', { count: 'exact' })
        .order('collected_at', { ascending: false })
        .range(0, 19),
      supabase.rpc('dashboard_summary').single(),
      supabase
        .from('business_settings')
        .select('business_name,receipt_prefix')
        .eq('id', true)
        .single(),
    ])
    const failure = c.error ?? e.error ?? s.error ?? settings.error
    if (failure) setError(failure.message)
    else {
      setCustomers((c.data ?? []) as Customer[])
      setEntries((e.data ?? []) as CollectionEntry[])
      setCount(e.count ?? 0)
      setSummary((s.data as Summary | null) ?? zeroSummary)
      setBusinessName(settings.data?.business_name ?? 'Daily Collection Pro')
      setReceiptPrefix(settings.data?.receipt_prefix ?? 'DCP')
    }
    if (profile.role === 'admin') {
      const team = await supabase
        .from('profiles')
        .select('id,display_name,role,active')
        .eq('role', 'collector')
        .order('display_name')
      if (team.error) setError((current) => current || team.error.message)
      else setCollectors((team.data ?? []) as Profile[])
    }
    setLoading(false)
  }, [profile])
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void loadData()
    })
    return () => {
      active = false
    }
  }, [loadData])

  useEffect(() => {
    if (!customerDetail || !supabase) return
    let cancelled = false
    void supabase
      .from('collection_entries')
      .select('*')
      .eq('customer_id', customerDetail.id)
      .order('collected_at', { ascending: false })
      .limit(5000)
      .then(({ data, error: historyError }) => {
        if (cancelled) return
        if (historyError) setError(historyError.message)
        else setCustomerPayments((data ?? []) as CollectionEntry[])
      })
    return () => {
      cancelled = true
    }
  }, [customerDetail])

  const fetchEntries = async (nextPage = 0, max = 20, reportRangeOnly = false) => {
    if (!supabase) return
    setLoading(true)
    setError('')
    const until = to ? new Date(`${to}T00:00:00+05:30`) : null
    until?.setUTCDate(until.getUTCDate() + 1)
    const {
      data,
      error: fetchError,
      count: total,
    } = await supabase
      .rpc(
        'search_collection_entries',
        {
          p_search: reportRangeOnly ? null : query.trim() || null,
          p_collector_id: reportRangeOnly ? null : collectorFilter || null,
          p_customer_id: reportRangeOnly ? null : customerFilter || null,
          p_payment_method: reportRangeOnly ? null : methodFilter || null,
          p_from: from ? `${from}T00:00:00+05:30` : null,
          p_until: until?.toISOString() ?? null,
        },
        { count: 'exact' },
      )
      .order('collected_at', { ascending: false })
      .range(nextPage * max, nextPage * max + max - 1)
    if (fetchError) setError(fetchError.message)
    else {
      setEntries((data ?? []) as CollectionEntry[])
      setCount(total ?? 0)
      setPage(nextPage)
    }
    setLoading(false)
  }

  const runReport = async () => {
    await fetchEntries(0, 5000, true)
    if (!supabase) return
    const until = to ? new Date(`${to}T00:00:00+05:30`) : null
    until?.setUTCDate(until.getUTCDate() + 1)
    const { data, error: reportError } = await supabase.rpc('collection_report', {
      p_from: from ? `${from}T00:00:00+05:30` : null,
      p_until: until?.toISOString() ?? null,
    })
    if (reportError) setError(reportError.message)
    else setReportData(data as CollectionReport)
  }

  const notify = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 3200)
  }
  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return
    const form = new FormData(event.currentTarget)
    setAuthError('')
    const { error: loginError } = await supabase.auth.signInWithPassword({
      email: String(form.get('email')).trim(),
      password: String(form.get('password')),
    })
    if (loginError) setAuthError(loginError.message)
  }
  const openEntry = async (entry: CollectionEntry) => {
    setSelected(entry)
    setAudit([])
    if (!supabase) return
    const { data } = await supabase
      .from('collection_revisions')
      .select('id,action,reason,actor_id,created_at')
      .eq('entry_id', entry.id)
      .order('created_at', { ascending: false })
    setAudit((data ?? []) as AuditItem[])
  }
  const openCustomer = (customer: Customer) => {
    setCustomerPayments([])
    setCustomerDetail(customer)
  }

  const exportCsv = async (reportRangeOnly = false) => {
    if (!supabase) return
    setLoading(true)
    const until = to ? new Date(`${to}T00:00:00+05:30`) : null
    until?.setUTCDate(until.getUTCDate() + 1)
    const { data, error: exportError } = await supabase
      .rpc(
        'search_collection_entries',
        {
          p_search: reportRangeOnly ? null : query.trim() || null,
          p_collector_id: reportRangeOnly ? null : collectorFilter || null,
          p_customer_id: reportRangeOnly ? null : customerFilter || null,
          p_payment_method: reportRangeOnly ? null : methodFilter || null,
          p_from: from ? `${from}T00:00:00+05:30` : null,
          p_until: until?.toISOString() ?? null,
        },
        { count: 'exact' },
      )
      .order('collected_at', { ascending: false })
      .limit(5000)
    setLoading(false)
    if (exportError) {
      setError(exportError.message)
      return
    }
    const exportEntries = (data ?? []) as CollectionEntry[]
    const customerById = new Map(customers.map((item) => [item.id, item]))
    const lines = [
      [
        'Receipt',
        'Date (Asia/Kolkata)',
        'Customer code',
        'Customer',
        'Collector',
        'Amount INR',
        'Method',
        'Status',
        'Notes',
      ]
        .map(escapeCsvCell)
        .join(','),
      ...exportEntries.map((entry) => {
        const customer = customerById.get(entry.customer_id)
        const collector = collectors.find((item) => item.id === entry.collector_id)
        return [
          entry.receipt_number,
          formatIndiaDate(entry.collected_at),
          customer?.customer_code,
          customer?.full_name,
          collector?.display_name ?? profile?.display_name,
          formatINR(entry.amount_paise).replace('₹', ''),
          entry.payment_method,
          entry.status,
          entry.notes,
        ]
          .map(escapeCsvCell)
          .join(',')
      }),
    ]
    const url = URL.createObjectURL(
      new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `daily-collection-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
    if (exportEntries.length === 5000)
      notify('Export capped at 5,000 rows; narrow the date range for a complete report.')
  }

  if (!ready || (!!session && !profile && !authError))
    return (
      <div className="full-loader">
        <LoaderCircle className="spin" size={23} /> Checking secure session
      </div>
    )
  if (!session || !profile)
    return <Login onSubmit={login} error={authError} configured={isSupabaseConfigured} />
  const isAdmin = profile.role === 'admin'
  const title = nav[profile.role].find(([id]) => id === view)?.[1] ?? 'Overview'
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" onClick={() => setView('overview')}>
          <span className="brand-mark">
            <BadgeIndianRupee size={22} />
          </span>
          <span>
            <strong>{businessName}</strong>
            <small>PRO WORKSPACE</small>
          </span>
        </a>
        <div className="side-label">WORKSPACE</div>
        <nav>
          {nav[profile.role].map(([id, label, Icon]) => (
            <button
              key={id}
              className={`nav-item ${view === id ? 'active' : ''}`}
              onClick={() => {
                setView(id)
                setCustomerDetail(null)
                setSelected(null)
                if (id === 'collections') void fetchEntries()
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === 'collect' && <kbd>+</kbd>}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="secure-note">
          <ShieldCheck size={17} />
          <span>
            Protected workspace<small>Session encrypted</small>
          </span>
        </div>
        <button className="profile-chip" onClick={() => void supabase?.auth.signOut()}>
          <span className="avatar">{profile.display_name.slice(0, 1).toUpperCase()}</span>
          <span>
            <strong>{profile.display_name}</strong>
            <small>{isAdmin ? 'Administrator' : 'Collector'}</small>
          </span>
          <LogOut size={17} />
        </button>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand">
            <span className="brand-mark">
              <BadgeIndianRupee size={20} />
            </span>
            <strong>{businessName}</strong>
          </div>
          <div className="breadcrumb">
            <span>Workspace</span>
            <ArrowRight size={14} />
            <strong>{customerDetail?.full_name ?? title}</strong>
          </div>
          <span className={`live-status ${online ? '' : 'offline'}`}>
            <i /> {online ? 'Live data' : 'Offline · submissions paused'}
          </span>
        </header>
        <div className="page-content">
          {error && (
            <div className="error-banner">
              <CircleAlert size={17} />
              {error}
              <button onClick={() => setError('')} aria-label="Dismiss">
                <X size={16} />
              </button>
            </div>
          )}
          {!online && (
            <div className="error-banner">
              <CircleAlert size={17} />
              You are offline. Collection entries are not queued or saved; reconnect before
              submitting.
            </div>
          )}
          {view === 'overview' && (
            <Overview
              profile={profile}
              summary={summary}
              activeCollectors={collectors.filter((person) => person.active).length}
              entries={entries.slice(0, 6)}
              customers={customers}
              loading={loading}
              onCollect={() => setView('collect')}
              onOpen={openEntry}
              onViewAll={() => {
                setView('collections')
                void fetchEntries()
              }}
            />
          )}
          {view === 'collect' && (
            <Collect
              customers={customers}
              online={online}
              onSaved={async (receipt) => {
                notify(`Collection saved · ${receipt}`)
                await loadData()
                setView('overview')
              }}
            />
          )}
          {view === 'collections' && (
            <Collections
              entries={entries}
              customers={customers}
              collectors={collectors}
              isAdmin={isAdmin}
              query={query}
              setQuery={setQuery}
              from={from}
              to={to}
              setFrom={setFrom}
              setTo={setTo}
              collectorFilter={collectorFilter}
              setCollectorFilter={setCollectorFilter}
              customerFilter={customerFilter}
              setCustomerFilter={setCustomerFilter}
              methodFilter={methodFilter}
              setMethodFilter={setMethodFilter}
              page={page}
              count={count}
              loading={loading}
              onFilter={() => void fetchEntries()}
              onPage={(next) => void fetchEntries(next)}
              onOpen={openEntry}
              onExport={exportCsv}
            />
          )}
          {view === 'customers' &&
            (customerDetail ? (
              <CustomerDetail
                customer={customerDetail}
                collectors={collectors}
                isAdmin={isAdmin}
                entries={customerPayments}
                onBack={() => {
                  setCustomerPayments([])
                  setCustomerDetail(null)
                }}
                onOpen={openEntry}
                onSaved={async () => {
                  await loadData()
                  setCustomerDetail(null)
                  notify('Customer updated')
                }}
              />
            ) : (
              <CustomerManager
                customers={customers}
                collectors={collectors}
                isAdmin={isAdmin}
                onOpen={openCustomer}
                onSaved={async () => {
                  await loadData()
                  notify('Customer saved')
                }}
              />
            ))}
          {view === 'reports' && isAdmin && (
            <>
              <ReportPresets setFrom={setFrom} setTo={setTo} />
              <Reports
                entries={entries}
                customers={customers}
                collectors={collectors}
                report={reportData}
                from={from}
                to={to}
                setFrom={setFrom}
                setTo={setTo}
                onRun={() => void runReport()}
                onExport={() => exportCsv(true)}
              />
            </>
          )}
          {view === 'team' && isAdmin && <Team collectors={collectors} onSaved={loadData} />}
          {view === 'settings' && isAdmin && (
            <BusinessSettings
              businessName={businessName}
              receiptPrefix={receiptPrefix}
              onSaved={(name, prefix) => {
                setBusinessName(name)
                setReceiptPrefix(prefix)
                notify('Business settings saved')
              }}
            />
          )}
        </div>
      </main>
      <nav className="mobile-nav">
        {nav[profile.role].map(([id, label, Icon]) => (
          <button
            key={id}
            className={view === id ? 'active' : ''}
            onClick={() => {
              setView(id)
              setCustomerDetail(null)
              if (id === 'collections') void fetchEntries()
            }}
          >
            <Icon size={19} />
            <span>{label === 'Quick collection' ? 'Collect' : label}</span>
          </button>
        ))}
      </nav>
      {toast && (
        <div className="toast">
          <Check size={17} />
          {toast}
        </div>
      )}
      {selected && (
        <EntryDialog
          entry={selected}
          customer={customers.find((item) => item.id === selected.customer_id)}
          collector={collectors.find((item) => item.id === selected.collector_id)}
          audit={audit}
          isAdmin={isAdmin}
          onClose={() => setSelected(null)}
          onChanged={async () => {
            setSelected(null)
            await loadData()
            if (view === 'collections') await fetchEntries(page)
          }}
        />
      )}
    </div>
  )
}

function Login({
  onSubmit,
  error,
  configured,
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  error: string
  configured: boolean
}) {
  return (
    <div className="login-layout">
      <section className="login-art">
        <Brand light />
        <div className="login-copy">
          <span className="eyebrow">COLLECTIONS, IN GOOD ORDER</span>
          <h1>
            Every day,
            <br />
            accounted for.
          </h1>
          <p>
            A clear view of your collections, your customers, and the work that keeps them moving.
          </p>
        </div>
        <div className="login-art-footer">
          <ShieldCheck size={17} /> Secure team access <span>·</span> Asia/Kolkata
        </div>
        <div className="grid-stamp" aria-hidden="true">
          <span>₹</span>
          <i />
          <i />
          <i />
          <i />
        </div>
      </section>
      <section className="login-panel">
        <form className="login-form-wrap" onSubmit={onSubmit}>
          <span className="eyebrow">WELCOME BACK</span>
          <h2>Sign in to continue</h2>
          <p className="muted">Use the account provided by your administrator.</p>
          {!configured && (
            <div className="setup-notice">
              <CircleAlert size={18} />
              <span>
                <strong>Backend setup required</strong>
                <br />
                Add your Supabase URL and anon key to <code>.env.local</code>. No demo records are
                shown.
              </span>
            </div>
          )}
          {error && (
            <div className="form-error">
              <CircleAlert size={16} />
              {error}
            </div>
          )}
          <label>
            Email address
            <input
              name="email"
              type="email"
              autoComplete="username"
              placeholder="name@business.in"
              required
              disabled={!configured}
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              required
              disabled={!configured}
            />
          </label>
          <button className="primary-button login-button" disabled={!configured}>
            Sign in securely <ArrowRight size={17} />
          </button>
          <div className="login-foot">
            <ShieldCheck size={16} /> Your access is protected by your business account.
          </div>
        </form>
        <footer className="login-copyright">
          DAILY COLLECTION PRO <span>·</span> FINANCIAL WORKSPACE
        </footer>
      </section>
    </div>
  )
}
function Brand({ light = false }: { light?: boolean }) {
  return (
    <a className={`brand ${light ? 'brand-light' : ''}`} href="#home">
      <span className="brand-mark">
        <BadgeIndianRupee size={22} />
      </span>
      <span>
        <strong>
          daily<span>collection</span>
        </strong>
        <small>PRO WORKSPACE</small>
      </span>
    </a>
  )
}
function Heading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="heading-action">{action}</div>}
    </div>
  )
}
function Stat({
  label,
  value,
  note,
  icon: Icon,
  color,
}: {
  label: string
  value: string
  note: string
  icon: typeof Banknote
  color: string
}) {
  return (
    <article className="stat-card">
      <div className={`stat-icon ${color}`}>
        <Icon size={20} />
      </div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">{note}</div>
    </article>
  )
}
function Overview({
  profile,
  summary,
  activeCollectors,
  entries,
  customers,
  loading,
  onCollect,
  onOpen,
  onViewAll,
}: {
  profile: Profile
  summary: Summary
  activeCollectors: number
  entries: CollectionEntry[]
  customers: Customer[]
  loading: boolean
  onCollect: () => void
  onOpen: (entry: CollectionEntry) => void
  onViewAll: () => void
}) {
  const admin = profile.role === 'admin'
  const [todayLabel] = useState(() =>
    new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'full',
    }).format(new Date()),
  )
  return (
    <>
      <Heading
        eyebrow={`${admin ? 'ADMINISTRATOR' : 'COLLECTOR'} DASHBOARD · ${todayLabel}`}
        title={`${admin ? 'Good day' : 'Namaste'}, ${profile.display_name.split(' ')[0]}`}
        description={
          admin
            ? 'Here is the pulse of your collection business.'
            : 'A fresh day. Your collection desk is ready.'
        }
        action={
          !admin && (
            <button className="primary-button" onClick={onCollect}>
              <Plus size={18} /> Record collection
            </button>
          )
        }
      />
      <section className={`stats-grid ${admin ? 'stats-admin' : ''}`}>
        <Stat
          label="Collected today"
          value={formatINR(summary.today_total_paise)}
          note="Posted collections · IST"
          icon={BadgeIndianRupee}
          color="green"
        />
        <Stat
          label="Transactions"
          value={Number(summary.today_count).toLocaleString('en-IN')}
          note="Receipts issued today"
          icon={ReceiptText}
          color="navy"
        />
        {admin ? (
          <>
            <Stat
              label="Cash received"
              value={formatINR(summary.cash_total_paise)}
              note="Cash collections · today"
              icon={Banknote}
              color="ochre"
            />
            <Stat
              label="Digital received"
              value={formatINR(summary.digital_total_paise)}
              note="UPI, bank & other · today"
              icon={WalletCards}
              color="blue"
            />
            <Stat
              label="Active collectors"
              value={activeCollectors.toLocaleString('en-IN')}
              note="Accounts with access"
              icon={Users}
              color="green"
            />
          </>
        ) : (
          <Stat
            label="My customers"
            value={customers.length.toLocaleString('en-IN')}
            note="Assigned to your account"
            icon={Users}
            color="blue"
          />
        )}
      </section>
      <section className="content-grid overview-grid">
        <div className="panel recent-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">LATEST ACTIVITY</div>
              <h2>Recent collections</h2>
            </div>
            <button className="text-button" onClick={onViewAll}>
              View all <ArrowRight size={15} />
            </button>
          </div>
          {loading && !entries.length ? (
            <Loading />
          ) : entries.length ? (
            <div className="activity-list">
              {entries.map((entry) => (
                <ActivityRow
                  key={entry.id}
                  entry={entry}
                  customer={customers.find((item) => item.id === entry.customer_id)}
                  onClick={() => onOpen(entry)}
                />
              ))}
            </div>
          ) : (
            <Empty
              icon={ReceiptText}
              title="No collections yet"
              text="Confirmed receipts will appear here."
            />
          )}
        </div>
        <div className="side-stack">
          <div className="quick-panel">
            <div className="quick-orbit">
              <ArrowDownToLine size={20} />
            </div>
            <span className="eyebrow">READY WHEN YOU ARE</span>
            <h2>
              Keep the day
              <br />
              moving.
            </h2>
            <p>Record a payment and create a numbered receipt in one short step.</p>
            <button className="dark-button" onClick={onCollect}>
              New collection <ArrowRight size={16} />
            </button>
          </div>
          <div className="timezone-note">
            <Clock3 size={17} />
            <span>
              <strong>Business time</strong>
              <small>Dates use Asia/Kolkata.</small>
            </span>
            <span className="timezone-pill">IST</span>
          </div>
        </div>
      </section>
    </>
  )
}
function ActivityRow({
  entry,
  customer,
  onClick,
}: {
  entry: CollectionEntry
  customer?: Customer
  onClick: () => void
}) {
  return (
    <button className="activity-row" onClick={onClick}>
      <span className={`activity-method ${entry.payment_method}`}>
        <Banknote size={17} />
      </span>
      <span className="activity-info">
        <strong>{customer?.full_name ?? 'Customer'}</strong>
        <small>
          {entry.receipt_number} · {formatIndiaDate(entry.collected_at)}
        </small>
      </span>
      <strong className="activity-amount">{formatINR(entry.amount_paise)}</strong>
      <ArrowRight className="activity-arrow" size={16} />
    </button>
  )
}

function Collect({
  customers,
  online,
  onSaved,
}: {
  customers: Customer[]
  online: boolean
  onSaved: (receipt: string) => Promise<void>
}) {
  const [amount, setAmount] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [time, setTime] = useState(indiaDateTimeInput())
  const [method, setMethod] = useState<CollectionEntry['payment_method']>('cash')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [key, setKey] = useState(() => crypto.randomUUID())
  const active = customers.filter((item) => item.status === 'active')
  const customer = active.find((item) => item.id === customerId)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return
    if (!online) {
      setError('You are offline. This collection was not saved. Reconnect, then retry.')
      return
    }
    const paise = parseRupeesToPaise(amount)
    setError('')
    if (!paise) {
      setError('Enter a positive amount with up to two decimal places.')
      return
    }
    if (!customer) {
      setError('Choose an active customer.')
      return
    }
    if (
      !window.confirm(
        `Record ${formatINR(paise)} from ${customer.full_name}? A receipt will be issued.`,
      )
    )
      return
    setSaving(true)
    const form = new FormData(event.currentTarget)
    const { data, error: saveError } = await supabase.rpc('submit_collection', {
      p_customer_id: customerId,
      p_amount_paise: paise.toString(),
      p_collected_at: indiaTimestamp(time),
      p_payment_method: method,
      p_notes: String(form.get('notes')).trim() || null,
      p_idempotency_key: key,
    })
    setSaving(false)
    if (saveError) {
      setError(`${saveError.message} The request key is retained for a safe retry.`)
      return
    }
    setKey(crypto.randomUUID())
    setAmount('')
    setCustomerId('')
    await onSaved((data as CollectionEntry).receipt_number)
  }
  const saveLabel = !online ? 'Reconnect to save' : saving ? 'Saving securely' : 'Review & save'
  return (
    <>
      <Heading
        eyebrow="NEW RECEIPT"
        title="Record a collection"
        description="Review the details before issuing a numbered receipt."
      />
      <div className="form-layout">
        <form className="panel collection-form" onSubmit={submit}>
          {error && (
            <div className="form-error">
              <CircleAlert size={16} />
              {error}
            </div>
          )}
          <div className="form-section-title">
            <span>01</span>
            <div>
              <strong>Customer and amount</strong>
              <small>Select an active assigned customer.</small>
            </div>
          </div>
          <label>
            Customer
            <select
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
              required
            >
              <option value="">Choose customer</option>
              {active.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.customer_code} · {item.full_name}
                </option>
              ))}
            </select>
          </label>
          <label className="amount-input-label">
            Amount received <span>INR</span>
            <div className="amount-input-wrap">
              <b>₹</b>
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                required
              />
            </div>
          </label>
          <div className="form-grid">
            <label>
              Collection date & time
              <input
                type="datetime-local"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                required
              />
            </label>
            <label>
              Payment method
              <select
                value={method}
                onChange={(event) =>
                  setMethod(event.target.value as CollectionEntry['payment_method'])
                }
              >
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="bank_transfer">Bank transfer</option>
                <option value="other">Other</option>
              </select>
            </label>
          </div>
          <label>
            Notes <span className="optional">OPTIONAL</span>
            <textarea
              name="notes"
              rows={3}
              maxLength={1000}
              placeholder="Add a short note for your records"
            />
          </label>
          <div className="form-actions">
            <span>
              <ShieldCheck size={16} /> Server confirms before receipt
            </span>
            <button className="primary-button" disabled={!online || saving || !active.length}>
              {saving && <LoaderCircle className="spin" size={16} />}
              {saveLabel}
              <ArrowRight size={17} />
            </button>
          </div>
        </form>
        <aside className="form-aside">
          <div className="receipt-preview">
            <div className="receipt-preview-top">
              <ReceiptText size={18} />
              <span>DIGITAL RECEIPT</span>
            </div>
            <div className="receipt-amount">
              {parseRupeesToPaise(amount) ? formatINR(parseRupeesToPaise(amount)!) : '₹0.00'}
            </div>
            <ReceiptLine label="Customer" value={customer?.full_name ?? 'Not selected'} />
            <ReceiptLine label="Method" value={method.replace('_', ' ')} />
            <ReceiptLine label="Time" value={`${time || '—'} IST`} />
            <div className="receipt-dash" />
            <div className="receipt-preview-foot">
              <Check size={15} /> Receipt number appears after saving
            </div>
          </div>
          <div className="security-aside">
            <ShieldCheck size={20} />
            <strong>Server confirmed</strong>
            <p>
              Amounts are saved as whole paise. Retry uses the same request key to avoid duplicates.
            </p>
          </div>
        </aside>
      </div>
    </>
  )
}
function ReceiptLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="receipt-preview-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function Collections({
  entries,
  customers,
  collectors,
  isAdmin,
  query,
  setQuery,
  from,
  to,
  setFrom,
  setTo,
  collectorFilter,
  setCollectorFilter,
  customerFilter,
  setCustomerFilter,
  methodFilter,
  setMethodFilter,
  page,
  count,
  loading,
  onFilter,
  onPage,
  onOpen,
  onExport,
}: {
  entries: CollectionEntry[]
  customers: Customer[]
  collectors: Profile[]
  isAdmin: boolean
  query: string
  setQuery: (value: string) => void
  from: string
  to: string
  setFrom: (value: string) => void
  setTo: (value: string) => void
  collectorFilter: string
  setCollectorFilter: (value: string) => void
  customerFilter: string
  setCustomerFilter: (value: string) => void
  methodFilter: string
  setMethodFilter: (value: string) => void
  page: number
  count: number
  loading: boolean
  onFilter: () => void
  onPage: (page: number) => void
  onOpen: (entry: CollectionEntry) => void
  onExport: () => void
}) {
  return (
    <>
      <Heading
        eyebrow={isAdmin ? 'LEDGER' : 'YOUR RECEIPTS'}
        title={isAdmin ? 'Collections' : 'Collection history'}
        description={
          isAdmin
            ? 'Posted and reversed transactions with their receipt trail.'
            : 'Your confirmed collection history.'
        }
        action={
          isAdmin && (
            <>
              <button className="secondary-button" onClick={() => window.print()}>
                <Printer size={16} /> Print
              </button>
              <button className="secondary-button" onClick={onExport}>
                <ArrowDownToLine size={16} /> Export CSV
              </button>
            </>
          )
        }
      />
      <div className="panel table-panel">
        <div className="filter-bar">
          <label className="search-field">
            <Search size={17} />
            <input
              placeholder="Search receipt, customer or code"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="date-filters">
            <label>
              <span>FROM</span>
              <input
                aria-label="From date"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label>
              <span>TO</span>
              <input
                aria-label="To date"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
            {isAdmin && (
              <>
                <select
                  aria-label="Filter by collector"
                  value={collectorFilter}
                  onChange={(event) => setCollectorFilter(event.target.value)}
                >
                  <option value="">All collectors</option>
                  {collectors.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.display_name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by customer"
                  value={customerFilter}
                  onChange={(event) => setCustomerFilter(event.target.value)}
                >
                  <option value="">All customers</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.full_name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by payment method"
                  value={methodFilter}
                  onChange={(event) => setMethodFilter(event.target.value)}
                >
                  <option value="">All methods</option>
                  <option value="cash">Cash</option>
                  <option value="upi">UPI</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="other">Other</option>
                </select>
              </>
            )}
            <button className="filter-button" onClick={onFilter}>
              <Filter size={16} /> Apply
            </button>
          </div>
        </div>
        <EntryTable
          entries={entries}
          customers={customers}
          collectors={collectors}
          isAdmin={isAdmin}
          onOpen={onOpen}
          loading={loading}
        />
        <div className="table-footer">
          <span>
            {count
              ? `Showing ${page * 20 + 1}–${Math.min(page * 20 + 20, count)} of ${count.toLocaleString('en-IN')}`
              : 'No matching entries'}
          </span>
          <div className="pagination">
            <button
              disabled={!page || loading}
              onClick={() => onPage(page - 1)}
              aria-label="Previous page"
            >
              <ArrowLeft size={16} />
            </button>
            <span>
              {page + 1} / {Math.max(1, Math.ceil(count / 20))}
            </span>
            <button
              disabled={(page + 1) * 20 >= count || loading}
              onClick={() => onPage(page + 1)}
              aria-label="Next page"
            >
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
function EntryTable({
  entries,
  customers,
  collectors,
  isAdmin,
  onOpen,
  loading,
}: {
  entries: CollectionEntry[]
  customers: Customer[]
  collectors: Profile[]
  isAdmin: boolean
  onOpen: (entry: CollectionEntry) => void
  loading: boolean
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>RECEIPT</th>
            <th>CUSTOMER</th>
            {isAdmin && <th>COLLECTOR</th>}
            <th>DATE & TIME</th>
            <th>METHOD</th>
            <th>AMOUNT</th>
            <th>STATUS</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const customer = customers.find((item) => item.id === entry.customer_id)
            const collector = collectors.find((item) => item.id === entry.collector_id)
            return (
              <tr key={entry.id} className="click-row" onClick={() => onOpen(entry)}>
                <td>
                  <strong className="receipt-code">{entry.receipt_number}</strong>
                </td>
                <td>
                  <span className="table-primary">{customer?.full_name ?? 'Customer'}</span>
                  <small className="table-secondary">{customer?.customer_code ?? ''}</small>
                </td>
                {isAdmin && <td>{collector?.display_name ?? 'Collector'}</td>}
                <td>{formatIndiaDate(entry.collected_at)}</td>
                <td>
                  <span className="method-label">{entry.payment_method.replace('_', ' ')}</span>
                </td>
                <td className="amount-cell">{formatINR(entry.amount_paise)}</td>
                <td>
                  <span className={`status-pill ${entry.status}`}>{entry.status}</span>
                </td>
                <td>
                  <button
                    className="row-action"
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpen(entry)
                    }}
                    aria-label={`Open ${entry.receipt_number}`}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                </td>
              </tr>
            )
          })}
          {loading && !entries.length && (
            <tr>
              <td colSpan={8}>
                <Loading />
              </td>
            </tr>
          )}
          {!entries.length && !loading && (
            <tr>
              <td colSpan={8}>
                <Empty
                  icon={ReceiptText}
                  title="No collections found"
                  text="Try a different date range."
                />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function CustomerManager({
  customers,
  collectors,
  isAdmin,
  onOpen,
  onSaved,
}: {
  customers: Customer[]
  collectors: Profile[]
  isAdmin: boolean
  onOpen: (customer: Customer) => void
  onSaved: () => Promise<void>
}) {
  const [show, setShow] = useState(false)
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const filtered = customers.filter((item) =>
    `${item.full_name} ${item.customer_code} ${item.phone ?? ''}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return
    setSaving(true)
    setError('')
    const form = new FormData(event.currentTarget)
    const { error: insertError } = await supabase.from('customers').insert({
      customer_code: String(form.get('customer_code')).trim(),
      full_name: String(form.get('full_name')).trim(),
      phone: String(form.get('phone')).trim() || null,
      address: String(form.get('address')).trim() || null,
      collector_id: String(form.get('collector_id')),
    })
    setSaving(false)
    if (insertError) {
      setError(insertError.message)
      return
    }
    setShow(false)
    await onSaved()
  }
  return (
    <>
      <Heading
        eyebrow="CUSTOMER DIRECTORY"
        title="Customers"
        description={`${customers.length.toLocaleString('en-IN')} assigned customers · Details are access-controlled.`}
        action={
          isAdmin && (
            <button className="primary-button" onClick={() => setShow(!show)}>
              <Plus size={17} /> Add customer
            </button>
          )
        }
      />
      {show && (
        <form className="panel customer-create" onSubmit={add}>
          <div className="panel-heading">
            <div>
              <div className="eyebrow">NEW CUSTOMER</div>
              <h2>Customer details</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={() => setShow(false)}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
          {error && (
            <div className="form-error">
              <CircleAlert size={16} />
              {error}
            </div>
          )}
          <div className="form-grid">
            <label>
              Customer code
              <input name="customer_code" maxLength={40} required placeholder="CUST-001" />
            </label>
            <label>
              Full name
              <input name="full_name" maxLength={160} required placeholder="Customer name" />
            </label>
            <label>
              Phone <span className="optional">OPTIONAL</span>
              <input name="phone" type="tel" maxLength={30} />
            </label>
            <label>
              Assigned collector
              <select name="collector_id" required defaultValue="">
                <option value="" disabled>
                  Choose collector
                </option>
                {collectors
                  .filter((item) => item.active)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.display_name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <label>
            Address <span className="optional">OPTIONAL</span>
            <input name="address" maxLength={500} />
          </label>
          <div className="form-actions">
            <span>New customers begin active.</span>
            <button className="primary-button" disabled={saving}>
              {saving ? 'Saving…' : 'Create customer'}
            </button>
          </div>
        </form>
      )}
      <div className="panel customer-panel">
        <div className="customer-toolbar">
          <label className="search-field">
            <Search size={17} />
            <input
              placeholder="Search name, code or phone"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <span className="customer-count">{filtered.length} CUSTOMERS</span>
        </div>
        <div className="customer-grid">
          {filtered.map((customer) => {
            const collector = collectors.find((person) => person.id === customer.collector_id)
            return (
              <button className="customer-card" key={customer.id} onClick={() => onOpen(customer)}>
                <div className="customer-card-top">
                  <span className="customer-avatar">{customer.full_name.slice(0, 1)}</span>
                  <span className={`status-pill ${customer.status}`}>{customer.status}</span>
                </div>
                <strong>{customer.full_name}</strong>
                <span className="customer-code">{customer.customer_code}</span>
                <div className="customer-card-bottom">
                  <span>{customer.phone || 'No phone added'}</span>
                  <span>{collector?.display_name ?? 'Assigned'}</span>
                </div>
                <span className="card-arrow">
                  <ArrowRight size={16} />
                </span>
              </button>
            )
          })}
        </div>
        {!filtered.length && (
          <Empty
            icon={Users}
            title="No customers yet"
            text={
              isAdmin
                ? 'Add a customer to start assigning collections.'
                : 'Assigned customers will appear here.'
            }
          />
        )}
      </div>
    </>
  )
}
function CustomerDetail({
  customer,
  collectors,
  isAdmin,
  entries,
  onBack,
  onOpen,
  onSaved,
}: {
  customer: Customer
  collectors: Profile[]
  isAdmin: boolean
  entries: CollectionEntry[]
  onBack: () => void
  onOpen: (entry: CollectionEntry) => void
  onSaved: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const rows = entries.filter((item) => item.customer_id === customer.id)
  const total = rows
    .filter((item) => item.status === 'posted')
    .reduce((sum, item) => sum + BigInt(item.amount_paise), 0n)
  const update = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return
    const form = new FormData(event.currentTarget)
    setSaving(true)
    setError('')
    const { error: updateError } = await supabase
      .from('customers')
      .update({
        full_name: String(form.get('full_name')).trim(),
        phone: String(form.get('phone')).trim() || null,
        address: String(form.get('address')).trim() || null,
        collector_id: String(form.get('collector_id')),
        status: String(form.get('status')),
      })
      .eq('id', customer.id)
    setSaving(false)
    if (updateError) setError(updateError.message)
    else await onSaved()
  }
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} /> Customers
      </button>
      <Heading
        eyebrow={`CUSTOMER ${customer.customer_code}`}
        title={customer.full_name}
        description={customer.phone ?? 'No phone number'}
        action={
          isAdmin && (
            <button className="secondary-button" onClick={() => setEditing(!editing)}>
              {editing ? 'Close editor' : 'Edit customer'}
            </button>
          )
        }
      />
      {editing && isAdmin && (
        <form className="panel customer-create" onSubmit={update}>
          {error && (
            <div className="form-error">
              <CircleAlert size={16} />
              {error}
            </div>
          )}
          <div className="form-grid">
            <label>
              Full name
              <input name="full_name" defaultValue={customer.full_name} required maxLength={160} />
            </label>
            <label>
              Phone
              <input name="phone" defaultValue={customer.phone ?? ''} maxLength={30} />
            </label>
            <label>
              Assigned collector
              <select name="collector_id" defaultValue={customer.collector_id} required>
                {collectors.map((person) => (
                  <option
                    key={person.id}
                    value={person.id}
                    disabled={!person.active && person.id !== customer.collector_id}
                  >
                    {person.display_name}
                    {person.active ? '' : ' (inactive)'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Account status
              <select name="status" defaultValue={customer.status}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
          </div>
          <label>
            Address
            <input name="address" defaultValue={customer.address ?? ''} maxLength={500} />
          </label>
          <div className="form-actions">
            <span>
              Collection history remains linked if the customer is deactivated or reassigned.
            </span>
            <button className="primary-button" disabled={saving}>
              {saving ? 'Saving…' : 'Save customer'}
            </button>
          </div>
        </form>
      )}
      <div className="stats-grid">
        <Stat
          label="Total received"
          value={formatINR(total)}
          note="Posted payments · latest 5,000 receipts loaded"
          icon={BadgeIndianRupee}
          color="green"
        />
        <Stat
          label="Receipts"
          value={rows.filter((item) => item.status === 'posted').length.toString()}
          note="Confirmed collections"
          icon={ReceiptText}
          color="navy"
        />
        <Stat
          label="Status"
          value={customer.status}
          note={customer.address ?? 'No address added'}
          icon={Users}
          color="blue"
        />
      </div>
      <div className="panel table-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">PAYMENT HISTORY</div>
            <h2>Recent receipts · latest 5,000</h2>
          </div>
        </div>
        <EntryTable
          entries={rows}
          customers={[customer]}
          collectors={[]}
          isAdmin={false}
          onOpen={onOpen}
          loading={false}
        />
      </div>
    </>
  )
}

function Reports({
  entries,
  customers,
  collectors,
  report,
  from,
  to,
  setFrom,
  setTo,
  onRun,
  onExport,
}: {
  entries: CollectionEntry[]
  customers: Customer[]
  collectors: Profile[]
  report: CollectionReport | null
  from: string
  to: string
  setFrom: (value: string) => void
  setTo: (value: string) => void
  onRun: () => void
  onExport: () => void
}) {
  const total = BigInt(report?.summary.net_total_paise ?? 0)
  const cash = BigInt(report?.summary.cash_total_paise ?? 0)
  const digital = BigInt(report?.summary.digital_total_paise ?? 0)
  const byCollector = new Map(
    (report?.collectors ?? []).map((item) => [item.collector_id, BigInt(item.total_paise)]),
  )
  const byCustomer = new Map(
    (report?.customers ?? []).map((item) => [item.customer_id, BigInt(item.total_paise)]),
  )
  return (
    <>
      <Heading
        eyebrow="BUSINESS INTELLIGENCE"
        title="Reports"
        description="Date-range totals include posted, non-reversed entries."
        action={
          <>
            <button className="secondary-button" onClick={() => window.print()}>
              <Printer size={16} /> Print report
            </button>
            <button className="secondary-button" onClick={onExport}>
              <ArrowDownToLine size={16} /> Export CSV
            </button>
          </>
        }
      />
      <div className="panel report-filters">
        <div>
          <div className="eyebrow">REPORT PERIOD · IST</div>
          <strong>Select a collection date range</strong>
        </div>
        <div className="date-filters">
          <label>
            <span>FROM</span>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            <span>TO</span>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <button className="primary-button" onClick={onRun}>
            <Filter size={16} /> Run report
          </button>
        </div>
      </div>
      <div className="stats-grid">
        <Stat
          label="Net collections"
          value={report ? formatINR(total) : '—'}
          note={
            report
              ? `${report.summary.posted_count.toLocaleString('en-IN')} posted transactions`
              : 'Run a report to calculate totals'
          }
          icon={BadgeIndianRupee}
          color="green"
        />
        <Stat
          label="Cash"
          value={report ? formatINR(cash) : '—'}
          note="Cash method"
          icon={Banknote}
          color="ochre"
        />
        <Stat
          label="Digital & other"
          value={report ? formatINR(digital) : '—'}
          note="UPI, bank transfer & other"
          icon={WalletCards}
          color="blue"
        />
        <Stat
          label="Reversed"
          value={report ? report.summary.reversed_count.toLocaleString('en-IN') : '—'}
          note="Excluded from net totals"
          icon={Activity}
          color="navy"
        />
      </div>
      <div className="content-grid report-grid">
        {[
          [...byCollector]
            .sort((a, b) => (a[1] > b[1] ? -1 : 1))
            .map(
              ([id, amount]) =>
                [
                  collectors.find((item) => item.id === id)?.display_name ?? 'Collector',
                  amount,
                ] as const,
            ),
          [...byCustomer]
            .sort((a, b) => (a[1] > b[1] ? -1 : 1))
            .slice(0, 8)
            .map(
              ([id, amount]) =>
                [
                  customers.find((item) => item.id === id)?.full_name ?? 'Customer',
                  amount,
                ] as const,
            ),
        ].map((rows, index) => (
          <div className="panel" key={index}>
            <div className="panel-heading">
              <div>
                <div className="eyebrow">
                  {index ? 'CUSTOMER ACTIVITY' : 'COLLECTOR PERFORMANCE'}
                </div>
                <h2>{index ? 'Top customers' : 'By collector'}</h2>
              </div>
            </div>
            <div className="collector-totals">
              {rows.map(([name, amount]) => (
                <div className="collector-total-row" key={name}>
                  <span>{name}</span>
                  <strong>{formatINR(amount)}</strong>
                </div>
              ))}
              {!rows.length && (
                <Empty
                  icon={Users}
                  title="No report rows"
                  text="Run a date-range report to begin."
                />
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="panel table-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">SOURCE LEDGER</div>
            <h2>Report transactions</h2>
          </div>
          <span className="result-limit">First 20 shown · source limited to 5,000</span>
        </div>
        <EntryTable
          entries={entries.slice(0, 20)}
          customers={customers}
          collectors={collectors}
          isAdmin
          onOpen={() => undefined}
          loading={false}
        />
      </div>
    </>
  )
}

function ReportPresets({
  setFrom,
  setTo,
}: {
  setFrom: (value: string) => void
  setTo: (value: string) => void
}) {
  const setPeriod = (period: 'day' | 'week' | 'month') => {
    const today = indiaDateTimeInput().slice(0, 10)
    const start = new Date(`${today}T00:00:00Z`)
    if (period === 'week') start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
    if (period === 'month') start.setUTCDate(1)
    setFrom(start.toISOString().slice(0, 10))
    setTo(today)
  }
  return (
    <div className="report-presets">
      <span>QUICK PERIOD · IST</span>
      <button onClick={() => setPeriod('day')}>Today</button>
      <button onClick={() => setPeriod('week')}>This week</button>
      <button onClick={() => setPeriod('month')}>This month</button>
    </div>
  )
}

function BusinessSettings({
  businessName,
  receiptPrefix,
  onSaved,
}: {
  businessName: string
  receiptPrefix: string
  onSaved: (name: string, prefix: string) => void
}) {
  const [name, setName] = useState(businessName)
  const [prefix, setPrefix] = useState(receiptPrefix)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return
    const cleanName = name.trim()
    const cleanPrefix = prefix.trim().toUpperCase()
    if (!cleanName || cleanName.length > 120) {
      setError('Business name must be between 1 and 120 characters.')
      return
    }
    if (!/^[A-Z0-9]{2,8}$/.test(cleanPrefix)) {
      setError('Receipt prefix must use 2 to 8 letters or digits.')
      return
    }
    setSaving(true)
    setError('')
    const { error: saveError } = await supabase
      .from('business_settings')
      .update({ business_name: cleanName, receipt_prefix: cleanPrefix })
      .eq('id', true)
    setSaving(false)
    if (saveError) setError(saveError.message)
    else onSaved(cleanName, cleanPrefix)
  }
  return (
    <>
      <Heading
        eyebrow="BUSINESS IDENTITY"
        title="Business settings"
        description="Configure the name shown in your workspace and the prefix used on new receipts."
      />
      <form className="panel invite-panel settings-panel" onSubmit={save}>
        <div className="eyebrow">GENERAL</div>
        <h2>Receipt and business details</h2>
        <p className="muted">Currency and business dates are fixed to INR and Asia/Kolkata.</p>
        {error && (
          <div className="form-error">
            <CircleAlert size={16} /> {error}
          </div>
        )}
        <label>
          Business name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required
          />
        </label>
        <label>
          Receipt prefix
          <input
            value={prefix}
            onChange={(event) => setPrefix(event.target.value.toUpperCase())}
            minLength={2}
            maxLength={8}
            pattern="[A-Z0-9]{2,8}"
            required
          />
        </label>
        <div className="settings-preview">
          <ReceiptText size={17} /> New receipts will look like{' '}
          <strong>{prefix || 'DCP'}-YYYYMMDD-00000001</strong>
        </div>
        <button className="primary-button" disabled={saving}>
          {saving ? 'Saving settings…' : 'Save business settings'}
        </button>
      </form>
    </>
  )
}

function Team({ collectors, onSaved }: { collectors: Profile[]; onSaved: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return
    setSaving(true)
    setError('')
    const { error: inviteError } = await supabase.functions.invoke('create-collector', {
      body: { email: email.trim(), displayName: name.trim() },
    })
    setSaving(false)
    if (inviteError) {
      if (inviteError instanceof FunctionsHttpError) {
        const response = (await inviteError.context.json()) as { error?: unknown }
        setError(typeof response.error === 'string' ? response.error : inviteError.message)
      } else {
        setError(inviteError.message)
      }
      return
    }
    setName('')
    setEmail('')
    setMessage('Invitation sent. The collector sets their own password from the invite email.')
    await onSaved()
  }
  const toggle = async (person: Profile) => {
    if (
      !supabase ||
      !window.confirm(
        `${person.active ? 'Deactivate' : 'Reactivate'} ${person.display_name}? History is retained.`,
      )
    )
      return
    const { error: updateError } = await supabase.rpc('set_collector_active', {
      p_collector_id: person.id,
      p_active: !person.active,
    })
    if (updateError) setError(updateError.message)
    else await onSaved()
  }
  return (
    <>
      <Heading
        eyebrow="TEAM ACCESS"
        title="Collectors"
        description="Invite members and control account access without removing collection history."
      />
      <div className="content-grid team-grid">
        <form className="panel invite-panel" onSubmit={invite}>
          <div className="eyebrow">ADD A COLLECTOR</div>
          <h2>Send a secure invite</h2>
          <p className="muted">
            New accounts are created as collectors. They set their own password.
          </p>
          {error && (
            <div className="form-error">
              <CircleAlert size={16} />
              {error}
            </div>
          )}
          {message && (
            <div className="success-banner">
              <Check size={16} />
              {message}
            </div>
          )}
          <label>
            Display name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
            />
          </label>
          <label>
            Work email
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              required
            />
          </label>
          <button className="primary-button" disabled={saving}>
            {saving ? (
              'Sending invite…'
            ) : (
              <>
                <Plus size={17} /> Invite collector
              </>
            )}
          </button>
        </form>
        <div className="panel team-list">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">ACCESS ROSTER</div>
              <h2>
                {collectors.length} collector{collectors.length === 1 ? '' : 's'}
              </h2>
            </div>
            <Users size={19} />
          </div>
          {collectors.map((person) => (
            <div className="team-member" key={person.id}>
              <span className="avatar">{person.display_name.slice(0, 1)}</span>
              <span className="team-member-name">
                <strong>{person.display_name}</strong>
                <small>Collector account</small>
              </span>
              <span className={`status-pill ${person.active ? 'active' : 'inactive'}`}>
                {person.active ? 'active' : 'inactive'}
              </span>
              <button className="secondary-button small" onClick={() => void toggle(person)}>
                {person.active ? 'Deactivate' : 'Reactivate'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function EntryDialog({
  entry,
  customer,
  collector,
  audit,
  isAdmin,
  onClose,
  onChanged,
}: {
  entry: CollectionEntry
  customer?: Customer
  collector?: Profile
  audit: AuditItem[]
  isAdmin: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const edit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return
    const form = new FormData(event.currentTarget)
    const paise = parseRupeesToPaise(String(form.get('amount')))
    const reason = String(form.get('reason')).trim()
    if (!paise) {
      setError('Enter a valid positive amount.')
      return
    }
    if (reason.length < 3) {
      setError('Enter a correction reason of at least 3 characters.')
      return
    }
    setSaving(true)
    const { error: updateError } = await supabase.rpc('edit_collection', {
      p_entry_id: entry.id,
      p_amount_paise: paise.toString(),
      p_collected_at: indiaTimestamp(String(form.get('time'))),
      p_payment_method: String(form.get('method')),
      p_notes: String(form.get('notes')).trim() || null,
      p_reason: reason,
    })
    setSaving(false)
    if (updateError) setError(updateError.message)
    else await onChanged()
  }
  const reverse = async () => {
    if (!supabase) return
    const reason = window.prompt('Reason for reversing this collection:')
    if (
      !reason ||
      reason.trim().length < 3 ||
      !window.confirm(
        `Reverse ${entry.receipt_number}? History is retained and totals are reduced.`,
      )
    )
      return
    setSaving(true)
    const { error: reverseError } = await supabase.rpc('reverse_collection', {
      p_entry_id: entry.id,
      p_reason: reason.trim(),
    })
    setSaving(false)
    if (reverseError) setError(reverseError.message)
    else await onChanged()
  }
  const share = async () => {
    const text = `${entry.receipt_number} · ${formatINR(entry.amount_paise)} · ${customer?.full_name ?? 'Customer'} · ${formatIndiaDate(entry.collected_at)} IST`
    if (navigator.share)
      await navigator.share({ title: 'Collection receipt', text }).catch(() => undefined)
    else await navigator.clipboard.writeText(text)
  }
  return (
    <div
      className="dialog-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="dialog receipt-dialog" role="dialog" aria-modal="true">
        <div className="dialog-top">
          <div>
            <div className="eyebrow">COLLECTION RECEIPT</div>
            <h2>{entry.receipt_number}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={19} />
          </button>
        </div>
        {error && (
          <div className="form-error">
            <CircleAlert size={16} />
            {error}
          </div>
        )}
        {editing ? (
          <form className="edit-form" onSubmit={edit}>
            <label>
              Amount INR
              <input
                name="amount"
                defaultValue={`${BigInt(entry.amount_paise) / 100n}.${(BigInt(entry.amount_paise) % 100n).toString().padStart(2, '0')}`}
                required
              />
            </label>
            <label>
              Date & time IST
              <input
                name="time"
                type="datetime-local"
                defaultValue={indiaDateTimeInput(new Date(entry.collected_at))}
                required
              />
            </label>
            <label>
              Method
              <select name="method" defaultValue={entry.payment_method}>
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="bank_transfer">Bank transfer</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Notes
              <textarea name="notes" defaultValue={entry.notes ?? ''} maxLength={1000} />
            </label>
            <label>
              Correction reason
              <textarea name="reason" minLength={3} required maxLength={1000} />
            </label>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary-button" disabled={saving}>
                {saving ? 'Saving…' : 'Save correction'}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="dialog-amount">
              {formatINR(entry.amount_paise)}
              <span className={`status-pill ${entry.status}`}>{entry.status}</span>
            </div>
            <div className="receipt-details">
              <ReceiptLine
                label="Customer"
                value={`${customer?.full_name ?? 'Customer'} ${customer?.customer_code ?? ''}`}
              />
              <ReceiptLine label="Collector" value={collector?.display_name ?? 'Your account'} />
              <ReceiptLine
                label="Date & time"
                value={`${formatIndiaDate(entry.collected_at)} IST`}
              />
              <ReceiptLine label="Payment method" value={entry.payment_method.replace('_', ' ')} />
              <ReceiptLine label="Notes" value={entry.notes || 'No notes added'} />
            </div>
            <div className="audit-section">
              <div className="eyebrow">AUDIT HISTORY</div>
              {audit.length ? (
                audit.map((item) => (
                  <div className="audit-row" key={item.id}>
                    <span className="audit-icon">
                      <History size={15} />
                    </span>
                    <div>
                      <strong>
                        {item.action === 'edited' ? 'Collection corrected' : 'Collection reversed'}
                      </strong>
                      <p>{item.reason}</p>
                      <small>
                        {formatIndiaDate(item.created_at)} · {item.actor_id.slice(0, 8)}
                      </small>
                    </div>
                  </div>
                ))
              ) : (
                <p className="muted audit-empty">No corrections or reversals recorded.</p>
              )}
            </div>
            <div className="dialog-actions">
              <button className="secondary-button" onClick={() => void share()}>
                <Smartphone size={16} /> Share
              </button>
              <button className="secondary-button" onClick={() => window.print()}>
                <Printer size={16} /> Print
              </button>
              {isAdmin && entry.status === 'posted' && (
                <>
                  <button className="secondary-button" onClick={() => setEditing(true)}>
                    Edit
                  </button>
                  <button
                    className="danger-button"
                    disabled={saving}
                    onClick={() => void reverse()}
                  >
                    <X size={16} /> Reverse
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
function Empty({ icon: Icon, title, text }: { icon: typeof Users; title: string; text: string }) {
  return (
    <div className="empty-state">
      <span>
        <Icon size={21} />
      </span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  )
}
function Loading() {
  return (
    <div className="loading-rows">
      <LoaderCircle className="spin" size={20} /> Loading verified records…
    </div>
  )
}
