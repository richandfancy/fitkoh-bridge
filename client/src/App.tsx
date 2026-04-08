import { Route, Switch } from 'wouter'
import { Toaster } from 'sonner'
import { AuthProvider, useAuth } from '@/contexts/auth-context'
import { Layout } from '@/components/Layout'
import { LoginScreen } from '@/components/LoginScreen'
import { Loader2 } from 'lucide-react'

// Lazy-loaded pages (create stubs for now)
import { ActivityPage } from '@/pages/Activity'
import { GuestsPage } from '@/pages/Guests'
import { GuestDetailPage } from '@/pages/GuestDetail'
import { DeadLettersPage } from '@/pages/DeadLetters'
import { SettingsPage } from '@/pages/Settings'
import { PreInvoicePage } from '@/pages/PreInvoice'

function AppContent() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="min-h-dvh bg-background flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-primary" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <LoginScreen />
  }

  return (
    <Layout>
      <Switch>
        <Route path="/" component={ActivityPage} />
        <Route path="/guests" component={GuestsPage} />
        <Route path="/guests/:id" component={GuestDetailPage} />
        <Route path="/pre-invoice/:posterClientId?" component={PreInvoicePage} />
        <Route path="/dead-letters" component={DeadLettersPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route>
          <div className="text-center py-20 text-muted-foreground">Page not found</div>
        </Route>
      </Switch>
    </Layout>
  )
}

export function App() {
  return (
    <AuthProvider>
      <AppContent />
      <Toaster theme="dark" position="top-center" />
    </AuthProvider>
  )
}
