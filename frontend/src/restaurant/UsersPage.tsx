import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Button, Field, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { ROLE_LABEL, formatDate } from '../lib/format';
import type { Branch, Role, User } from '../lib/types';
import { canManage, useAdmin } from './context';

const ROLES = Object.keys(ROLE_LABEL) as Role[];

export default function UsersPage() {
  const { me } = useAdmin();
  const [users, setUsers] = useState<User[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<User | 'new' | null>(null);

  const load = useCallback(() => {
    api<{ users: User[] }>('/users').then((r) => setUsers(r.users)).catch((e) => setError(errorMessage(e)));
    api<{ branches: Branch[] }>('/branches').then((r) => setBranches(r.branches)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  if (!canManage(me.user.role)) return <Navigate to="/admin" replace />;
  const isAdmin = me.user.role === 'admin';
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name || '—';

  async function remove(u: User) {
    if (!window.confirm(`¿Borrar a ${u.name}?`)) return;
    try {
      await api(`/users/${u.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title="Usuarios"
        subtitle={isAdmin ? undefined : 'Solo un administrador puede crear o editar usuarios.'}
        actions={isAdmin && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nuevo usuario</Button>}
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!users ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Nombre</th>
                <th className="px-4 py-3 font-medium">Rol</th>
                <th className="px-4 py-3 font-medium">Sucursales</th>
                <th className="px-4 py-3 font-medium">Último acceso</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {users.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'opacity-50'}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{u.name} {u.id === me.user.id && <span className="text-xs text-gray-500">(tú)</span>}</div>
                    <div className="text-xs text-gray-500">{u.email}{!u.active && ' · desactivado'}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-300">{ROLE_LABEL[u.role]}</td>
                  <td className="px-4 py-3 text-gray-400">
                    {u.role === 'admin' ? 'Todas' : u.branch_ids.length ? u.branch_ids.map(branchName).join(', ') : <span className="text-amber-300">Sin sucursal</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(u.last_login_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {isAdmin && (
                      <div className="flex justify-end gap-1">
                        <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" onClick={() => setEditing(u)} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
                        {u.id !== me.user.id && <button className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-red-300" onClick={() => remove(u)} aria-label="Borrar"><Trash2 className="h-4 w-4" /></button>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <UserModal
          user={editing === 'new' ? null : editing}
          branches={branches}
          isSelf={editing !== 'new' && editing.id === me.user.id}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </>
  );
}

function UserModal({ user, branches, isSelf, onClose, onSaved }: {
  user: User | null; branches: Branch[]; isSelf: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: user?.name || '', email: user?.email || '', role: user?.role || ('cajero' as Role),
    password: '', active: user?.active ?? true, branch_ids: user?.branch_ids || (branches[0] ? [branches[0].id] : []),
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const toggleBranch = (id: string) => setForm((f) => ({
    ...f, branch_ids: f.branch_ids.includes(id) ? f.branch_ids.filter((b) => b !== id) : [...f.branch_ids, id],
  }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = { name: form.name, email: form.email, role: form.role, active: form.active, branch_ids: form.branch_ids };
      if (form.password) body.password = form.password;
      await api(user ? `/users/${user.id}` : '/users', { method: user ? 'PATCH' : 'POST', body });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal title={user ? 'Editar usuario' : 'Nuevo usuario'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Nombre"><input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Correo"><input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Rol">
          <select className="input" value={form.role} disabled={isSelf} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </Field>
        <Field label={user ? 'Nueva contraseña (opcional)' : 'Contraseña'} hint="Mínimo 8 caracteres">
          <input className="input" type="password" minLength={8} required={!user} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        {form.role !== 'admin' && (
          <div>
            <span className="label">Sucursales (la primera es la principal)</span>
            <div className="space-y-1.5">
              {branches.map((b) => (
                <label key={b.id} className="flex items-center gap-2 text-sm text-gray-300">
                  <input type="checkbox" checked={form.branch_ids.includes(b.id)} onChange={() => toggleBranch(b.id)} /> {b.name}
                </label>
              ))}
            </div>
          </div>
        )}
        {!isSelf && (
          <div className="flex items-center gap-3 text-sm text-gray-300">
            <Toggle label="Cuenta activa" checked={form.active} onChange={(v) => setForm({ ...form, active: v })} /> Cuenta activa
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={saving}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}
