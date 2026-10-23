import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { AppShell } from './AppShell';

export function ProtectedRoute() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <AppShell />;
}
