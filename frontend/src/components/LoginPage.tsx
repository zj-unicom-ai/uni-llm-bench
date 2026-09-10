import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Alert } from '../antdImports';
import { useAuth } from '../hooks/useAuth';
import { LanguageSwitcher } from './LanguageSwitcher';
import { LogoLockup } from './Logo';
import { APP_VERSION } from '../constants';

interface LoginPageProps {
  onLoginSuccess: () => void;
}

const inputClass =
  'w-full h-10 px-3 rounded-[8px] border border-border bg-white text-text-primary text-sm outline-none transition-all placeholder:text-text-tertiary focus:border-accent-blue focus:shadow-[0_0_0_3px_rgba(37,99,235,0.14)]';

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const { t } = useTranslation();
  const { loading, error, login, changePassword, clearError } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeLoading, setChangeLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await login(username, password);
    if (result.success) {
      if (result.passwordChangeRequired) {
        setShowChangePassword(true);
      } else {
        onLoginSuccess();
      }
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangeError(null);

    if (newPassword.length < 6) {
      setChangeError(t('login.validation.passwordLength'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangeError(t('login.validation.passwordMismatch'));
      return;
    }
    if (newPassword === password) {
      setChangeError(t('login.validation.passwordSameAsOld'));
      return;
    }

    setChangeLoading(true);
    const success = await changePassword(password, newPassword);
    setChangeLoading(false);

    if (success) {
      setShowChangePassword(false);
      onLoginSuccess();
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 relative bg-bg-primary">
      {/* Ambient glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(900px 500px at 18% -5%, rgba(91,157,255,0.16), transparent 60%), radial-gradient(760px 460px at 85% 0%, rgba(155,125,255,0.14), transparent 62%)',
        }}
      />

      <div className="w-full max-w-[400px] relative">
        {/* Brand */}
        <div className="flex flex-col items-center mb-7">
          <LogoLockup size={44} />
          <p className="mt-3 text-[12px] text-text-tertiary text-center max-w-[280px]">{t('login.tagline')}</p>
        </div>

        {/* Card */}
        <div className="glass-card !p-7" style={{ boxShadow: 'var(--shadow-lg)' }}>
          {showChangePassword ? (
            <>
              <h2 className="text-text-primary text-[15px] font-semibold mb-1.5">{t('login.changePassword')}</h2>
              <p className="text-text-secondary text-xs mb-5 leading-relaxed">{t('login.changePasswordDesc')}</p>

              {changeError && (
                <Alert
                  title={changeError}
                  type="error"
                  showIcon
                  closable
                  onClose={() => setChangeError(null)}
                  style={{ marginBottom: 16 }}
                />
              )}

              <form onSubmit={handleChangePassword}>
                <div className="mb-4">
                  <label htmlFor="new-password" className="block text-text-secondary text-xs mb-1.5">
                    {t('login.newPassword')}
                  </label>
                  <input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={t('login.atLeast6Chars')}
                    autoFocus
                    className={inputClass}
                  />
                </div>
                <div className="mb-4">
                  <label htmlFor="confirm-password" className="block text-text-secondary text-xs mb-1.5">
                    {t('login.confirmPassword')}
                  </label>
                  <input
                    id="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t('login.reEnterPassword')}
                    className={inputClass}
                  />
                </div>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={changeLoading}
                  block
                  size="large"
                  style={{ marginTop: 8, fontWeight: 500 }}
                >
                  {t('login.changePassword')}
                </Button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-text-primary text-[15px] font-semibold mb-5">{t('login.signIn')}</h2>

              {error && (
                <Alert title={error} type="error" showIcon closable onClose={clearError} style={{ marginBottom: 16 }} />
              )}

              <form onSubmit={handleSubmit}>
                <div className="mb-4">
                  <label htmlFor="login-username" className="block text-text-secondary text-xs mb-1.5">
                    {t('login.username')}
                  </label>
                  <input
                    id="login-username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('login.usernamePlaceholder')}
                    autoFocus
                    className={inputClass}
                  />
                </div>
                <div className="mb-4">
                  <label htmlFor="login-password" className="block text-text-secondary text-xs mb-1.5">
                    {t('login.password')}
                  </label>
                  <input
                    id="login-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('login.enterPassword')}
                    className={inputClass}
                  />
                </div>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={loading}
                  block
                  size="large"
                  style={{ marginTop: 8, fontWeight: 500 }}
                >
                  {t('login.signIn')}
                </Button>
              </form>
            </>
          )}

          <div className="flex items-center justify-between mt-5 pt-3.5 border-t border-border">
            <LanguageSwitcher />
            <span className="text-[10px] text-text-tertiary font-mono">{APP_VERSION}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
