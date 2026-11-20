# Support mailbox setup (one-time, admin)

This connects **freightsupport@freightpop.com** to the FPX dashboard. FPX gets access to **that one mailbox
only**, not to anyone else's mail.

## What FPX does with the mailbox

- **Reads** messages in the Inbox and Sent Items (all history) so the dashboard can show each conversation as
  *awaiting reply* or *responded*.
- **Creates reply drafts** in the mailbox's Drafts folder when someone clicks "Create draft" (optionally written
  by AI). A person still opens the draft in Outlook, edits it, and sends it.
- **Never sends** email and **never deletes** anything, in Outlook or in FPX.

Why `Mail.ReadWrite` and not `Mail.Read`: Microsoft treats creating a draft as a write. Read-only access could not
put a reply draft in Outlook. FPX's code never calls send or delete.

## Who can do this

You need **Exchange Administrator** plus **Application Administrator** (or Cloud Application Administrator), or
**Global Administrator**. Plan for about 10 minutes, then up to 2 hours of waiting for Microsoft to apply it.

## Option A: run the script (recommended)

On a Mac or PC with PowerShell 7 (`brew install powershell` on a Mac):

```bash
cd FPX-RefreshAllShipments
pwsh ./scripts/azure/setup-support-mailbox.ps1
```

Options: `-Mailbox other@freightpop.com`, `-SecretMonths 12`, `-AppName "..."`, and `-UseDeviceCode` if the
browser sign-in pop-up doesn't work (you get a code to type at microsoft.com/devicelogin instead).

You sign in twice (Microsoft Graph, then Exchange Online). The script installs the Microsoft Graph modules it
needs the first time, for your user only.

What it does:

1. **Entra app registration** "FPX Support Mailbox", single tenant. If it already exists it is reused.
2. **Service principal** (enterprise application) for the app, created if missing.
3. **A new client secret**, valid 24 months by default.
4. It adds **no Microsoft Graph API permissions** in Entra. A Graph `Mail.ReadWrite` permission there would cover
   every mailbox in the company. The script warns you if the app already has any.
5. **Exchange Online**: checks the mailbox exists, registers the app's service principal with Exchange, creates
   the management scope **"FPX Support Mailbox Only"** (`PrimarySmtpAddress -eq 'freightsupport@freightpop.com'`),
   and assigns the role **Application Mail.ReadWrite** limited to that scope.
6. **Checks the result** against the support mailbox (should be `InScope = True`) and your own mailbox (should be
   `InScope = False`).
7. **Prints** the Tenant ID, Client ID, the secret value and its expiry date.

It is safe to run again. Anything that already exists is reused and reported, and it never removes anything.

Then:

1. Open **FPX dashboard → Admin → Support Mailbox**.
2. Paste the Tenant ID, Client ID and client secret, and click **Connect**.
3. If it says access is denied, the Exchange role hasn't taken effect yet. It can take **up to 2 hours**. Wait and
   click **Test connection** again.

> The secret is shown **once**. Paste it straight into FPX. Don't email it, put it in chat, or save it in a file.
> If you lose it, run the script again to get a new one.

## How to check it's working

- In FPX, **Admin → Support Mailbox** shows "connected" with Inbox and Sent Items message counts, and the
  **Support Mailbox** page starts filling up (the full history loads over several minutes to a few hours).
- In PowerShell, at any time:

  ```powershell
  Connect-ExchangeOnline
  $sp = Get-ServicePrincipal | Where-Object DisplayName -eq 'FPX Support Mailbox'
  Test-ServicePrincipalAuthorization -Identity $sp.Identity -Resource freightsupport@freightpop.com   # InScope True
  Test-ServicePrincipalAuthorization -Identity $sp.Identity -Resource you@freightpop.com              # InScope False
  ```

## Rotating the secret

1. Run the script again. It reuses the app and the Exchange setup and adds a **new** secret.
2. Paste the new secret in **FPX → Admin → Support Mailbox** and click **Connect** (this replaces the saved secret
   and keeps all synced mail).
3. Optional: once FPX shows connected, delete the old secret by hand in **Entra → App registrations →
   FPX Support Mailbox → Certificates & secrets**. The script never deletes secrets.

Set a calendar reminder a few weeks before the expiry date the script prints. When a secret expires, FPX shows the
connection as an error until a new one is pasted in.

## Option B: do it by hand (if you can't run the script)

### 1. Entra portal (entra.microsoft.com)

1. **App registrations → New registration**. Name: `FPX Support Mailbox`. Supported account types:
   **Accounts in this organizational directory only**. No redirect URI. Register.
2. Copy the **Application (client) ID** and **Directory (tenant) ID** from the Overview page.
3. **Certificates & secrets → New client secret** (24 months). Copy the **Value** now. It is shown once.
4. **Do not** add anything under **API permissions**. If `User.Read` (delegated) was added automatically, it is
   harmless, but don't add any *Application* permissions and don't click "Grant admin consent".
5. Go to **Enterprise applications**, search for `FPX Support Mailbox`, and copy its **Object ID**. This is the
   service principal's object ID, which is **not** the same as the Object ID on the App registration page.

### 2. Exchange Online PowerShell

```powershell
Connect-ExchangeOnline

$appId    = '<Application (client) ID>'
$spObject = '<Enterprise application Object ID>'
$mailbox  = 'freightsupport@freightpop.com'

Get-EXOMailbox -Identity $mailbox   # must exist; PrimarySmtpAddress must equal $mailbox

New-ServicePrincipal -AppId $appId -ObjectId $spObject -DisplayName 'FPX Support Mailbox'

New-ManagementScope -Name 'FPX Support Mailbox Only' `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq '$mailbox'"

New-ManagementRoleAssignment -App $appId -Role 'Application Mail.ReadWrite' `
  -CustomResourceScope 'FPX Support Mailbox Only'

Test-ServicePrincipalAuthorization -Identity $appId -Resource $mailbox             # InScope True
Test-ServicePrincipalAuthorization -Identity $appId -Resource you@freightpop.com   # InScope False
```

If one of the `New-*` commands says the object already exists, that step is already done. Move on to the next one.

The Exchange admin center has no screen for "RBAC for Applications". These steps have to be done in PowerShell.

### 3. FPX

Paste the Tenant ID, Client ID and secret into **FPX dashboard → Admin → Support Mailbox**, as in Option A.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| FPX: "access denied" / 403 right after connecting | Wait up to 2 hours for the Exchange role to apply, then **Test connection**. |
| FPX: "invalid client secret" / 401 | The secret was mistyped or has expired. Run the script again and paste the new secret. |
| Test shows `InScope False` for the support mailbox | Check the scope filter: `Get-ManagementScope 'FPX Support Mailbox Only' \| fl RecipientFilter`. It must use the mailbox's **primary** address. |
| Test shows `InScope True` for your own mailbox | Something gives the app wider access: a Graph application permission in Entra, or another role assignment. Check `Get-ManagementRoleAssignment -Role 'Application Mail.ReadWrite'` and the app's API permissions. |
| Script stops: "Found 2 app registrations named ..." | Keep one and rename or delete the extra by hand, then run again. |
