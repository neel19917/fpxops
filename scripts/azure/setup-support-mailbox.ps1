#Requires -Version 7.0
<#
.SYNOPSIS
  One-time (and re-runnable) setup that lets FPX read the support mailbox and create reply drafts in it,
  and nothing else in the tenant.

.DESCRIPTION
  1. Microsoft Entra: creates (or reuses) a single-tenant app registration "FPX Support Mailbox", makes sure it
     has a service principal (enterprise application), and adds a NEW client secret.
  2. Exchange Online: registers that service principal with Exchange, creates (or reuses) a management scope
     that matches only the support mailbox, and assigns the "Application Mail.ReadWrite" role limited to that
     scope (Exchange RBAC for Applications).
  3. Verifies with Test-ServicePrincipalAuthorization: the support mailbox should be InScope = True and another
     mailbox (yours) should be InScope = False.
  4. Prints Tenant ID, Client ID and the secret value (shown once) to paste into
     FPX dashboard -> Admin -> Support Mailbox.

  Safe to run again. Anything that already exists is reused and reported. The script never removes anything
  (no Remove-* cmdlets). Running it again adds a NEW secret (that is how you rotate it); old secrets stay valid
  until they expire or until an admin deletes them by hand in the Entra portal.

  Who can run it: someone who is Exchange Administrator AND (Application Administrator or Cloud Application
  Administrator), or a Global Administrator.

.PARAMETER Mailbox
  The only mailbox the app may access. Default freightsupport@freightpop.com.

.PARAMETER AppName
  Entra app registration display name. Default "FPX Support Mailbox".

.PARAMETER SecretMonths
  Lifetime of the new client secret in months. Default 24 (your tenant policy may cap this).

.PARAMETER UseDeviceCode
  Sign in with a device code instead of a browser pop-up (useful over SSH or when the browser sign-in fails).

.EXAMPLE
  pwsh ./scripts/azure/setup-support-mailbox.ps1

.EXAMPLE
  pwsh ./scripts/azure/setup-support-mailbox.ps1 -SecretMonths 12 -UseDeviceCode
#>
[CmdletBinding()]
param(
    [string]$Mailbox = 'freightsupport@freightpop.com',
    [string]$AppName = 'FPX Support Mailbox',
    [ValidateRange(1, 24)]
    [int]$SecretMonths = 24,
    [switch]$UseDeviceCode
)

# No Set-StrictMode: Exchange returns deserialized objects whose property sets vary by version.
$ErrorActionPreference = 'Stop'

$ScopeName = 'FPX Support Mailbox Only'
$RoleName  = 'Application Mail.ReadWrite'

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text)   { Write-Host "    [ok]     $Text" -ForegroundColor Green }
function Write-Reuse([string]$Text){ Write-Host "    [reused] $Text" -ForegroundColor Yellow }
function Write-Info([string]$Text) { Write-Host "    $Text" }
function Write-Warn2([string]$Text){ Write-Host "    [warn]   $Text" -ForegroundColor Magenta }

# ---------------------------------------------------------------------------------------------------------
# 0. Modules
# ---------------------------------------------------------------------------------------------------------
Write-Step 'Checking PowerShell modules'
foreach ($m in @('Microsoft.Graph.Authentication', 'Microsoft.Graph.Applications', 'ExchangeOnlineManagement')) {
    if (-not (Get-Module -ListAvailable -Name $m)) {
        Write-Info "Installing $m for the current user (one time)..."
        Install-Module -Name $m -Scope CurrentUser -Force -AllowClobber -Repository PSGallery
    }
    Import-Module $m -ErrorAction Stop
    $v = (Get-Module -Name $m | Select-Object -First 1).Version
    Write-Ok "$m $v"
}
$exoVersion = (Get-Module -Name ExchangeOnlineManagement | Select-Object -First 1).Version
if ($exoVersion.Major -lt 3) {
    throw "ExchangeOnlineManagement 3.x is required (found $exoVersion). Run: Update-Module ExchangeOnlineManagement"
}

# ---------------------------------------------------------------------------------------------------------
# 1. Microsoft Entra (Graph): app registration, service principal, client secret
# ---------------------------------------------------------------------------------------------------------
Write-Step 'Signing in to Microsoft Graph (needs Application.ReadWrite.All)'
$mgArgs = @{ Scopes = @('Application.ReadWrite.All'); NoWelcome = $true }
if ($UseDeviceCode) { $mgArgs.UseDeviceCode = $true }
Connect-MgGraph @mgArgs
$ctx = Get-MgContext
if (-not $ctx -or -not $ctx.TenantId) { throw 'Microsoft Graph sign-in did not complete.' }
$TenantId    = $ctx.TenantId
$SignedInUpn = $ctx.Account
Write-Ok "Signed in as $SignedInUpn (tenant $TenantId)"

Write-Step "Entra app registration '$AppName'"
$escapedName = $AppName.Replace("'", "''")
$apps = @(Get-MgApplication -Filter "displayName eq '$escapedName'" -All)
if ($apps.Count -gt 1) {
    $list = ($apps | ForEach-Object { "$($_.DisplayName)  appId=$($_.AppId)  created=$($_.CreatedDateTime)" }) -join "`n      "
    throw "Found $($apps.Count) app registrations named '$AppName'. Rename or remove the extras by hand so only one remains, then run again:`n      $list"
}
if ($apps.Count -eq 1) {
    $app = $apps[0]
    Write-Reuse "App registration already exists (appId $($app.AppId)); reusing it."
    if ($app.SignInAudience -ne 'AzureADMyOrg') {
        Write-Warn2 "Its sign-in audience is '$($app.SignInAudience)', not single tenant (AzureADMyOrg). Not changing it; review in the Entra portal."
    }
}
else {
    # NOTE: deliberately NO -RequiredResourceAccess here.
    # Granting Microsoft Graph application permissions such as Mail.Read / Mail.ReadWrite in Entra would give
    # this app access to EVERY mailbox in the tenant. Instead, mailbox access is granted only by Exchange Online
    # RBAC for Applications below, scoped to the single support mailbox.
    $app = New-MgApplication -DisplayName $AppName -SignInAudience 'AzureADMyOrg' `
        -Notes 'FPX dashboard access to the support mailbox only. Permissions come from Exchange Online RBAC for Applications (Application Mail.ReadWrite scoped to one mailbox). Do NOT add Microsoft Graph Mail.* application permissions here; they would be tenant-wide.'
    Write-Ok "Created app registration (appId $($app.AppId))"
}
$AppId = $app.AppId

# Warn (never change) if the app has tenant-wide Graph permissions configured; those would undo the scoping.
$rra = @($app.RequiredResourceAccess | Where-Object { $_ })
if ($rra.Count -gt 0) {
    Write-Warn2 'This app registration lists API permissions (requiredResourceAccess). FPX needs NONE.'
    Write-Warn2 'Any Graph application permission like Mail.Read/Mail.ReadWrite is tenant-wide and overrides the one-mailbox scope.'
    Write-Warn2 'Review it in Entra -> App registrations -> API permissions. This script will not change it.'
}

Write-Step 'Service principal (enterprise application)'
$sp = Get-MgServicePrincipal -Filter "appId eq '$AppId'" -All | Select-Object -First 1
if ($sp) {
    Write-Reuse "Service principal already exists (object id $($sp.Id))."
}
else {
    $sp = New-MgServicePrincipal -AppId $AppId
    Write-Ok "Created service principal (object id $($sp.Id))"
}
$SpObjectId = $sp.Id

# Check for admin-consented Graph app roles on the SP (that is what actually grants tenant-wide access).
try {
    $grants = @(Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $SpObjectId -All)
    if ($grants.Count -gt 0) {
        Write-Warn2 "The service principal has $($grants.Count) admin-consented application permission(s):"
        foreach ($g in $grants) { Write-Warn2 "  resource=$($g.ResourceDisplayName) appRoleId=$($g.AppRoleId)" }
        Write-Warn2 'These apply tenant-wide. FPX needs none. Review in Entra -> Enterprise applications -> Permissions.'
    }
    else {
        Write-Ok 'No Entra application permissions granted (as intended; access comes only from Exchange RBAC).'
    }
}
catch {
    Write-Warn2 "Could not list app role assignments: $($_.Exception.Message)"
}

Write-Step "Adding a new client secret (valid $SecretMonths months)"
$secretStart = Get-Date
$secretEnd   = $secretStart.AddMonths($SecretMonths)
$pwdCred = @{
    DisplayName   = "FPX dashboard $(Get-Date -Format 'yyyy-MM-dd')"
    StartDateTime = $secretStart.ToUniversalTime()
    EndDateTime   = $secretEnd.ToUniversalTime()
}
$secret = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential $pwdCred
if (-not $secret.SecretText) { throw 'Entra did not return a secret value.' }
Write-Ok "Created secret '$($secret.DisplayName)' (hint $($secret.Hint)), expires $($secret.EndDateTime.ToString('u'))"
$existingSecrets = @($app.PasswordCredentials | Where-Object { $_ })
if ($existingSecrets.Count -gt 0) {
    Write-Info "Note: this app already had $($existingSecrets.Count) other secret(s). They were NOT removed and stay valid until they expire;"
    Write-Info "      delete old ones by hand in Entra -> App registrations -> $AppName -> Certificates & secrets once FPX uses the new one."
}

# ---------------------------------------------------------------------------------------------------------
# 2. Exchange Online: service principal, management scope, scoped role assignment
# ---------------------------------------------------------------------------------------------------------
Write-Step 'Signing in to Exchange Online'
$exoArgs = @{ ShowBanner = $false }
if ($UseDeviceCode) { $exoArgs.Device = $true }
elseif ($SignedInUpn) { $exoArgs.UserPrincipalName = $SignedInUpn }
Connect-ExchangeOnline @exoArgs
Write-Ok 'Connected to Exchange Online'

Write-Step "Checking the mailbox $Mailbox exists"
try {
    $mbx = Get-EXOMailbox -Identity $Mailbox -Properties PrimarySmtpAddress, RecipientTypeDetails
}
catch {
    throw "Mailbox '$Mailbox' was not found in Exchange Online. Create it (or fix -Mailbox) and run again. ($($_.Exception.Message))"
}
if ($mbx.PrimarySmtpAddress -ne $Mailbox) {
    # The scope filter matches on PrimarySmtpAddress, so an alias would match nothing.
    throw "'$Mailbox' resolves to a mailbox whose PRIMARY address is '$($mbx.PrimarySmtpAddress)'. Run again with -Mailbox '$($mbx.PrimarySmtpAddress)' (the scope filter matches the primary address only)."
}
Write-Ok "Found $($mbx.PrimarySmtpAddress) ($($mbx.RecipientTypeDetails))"

Write-Step 'Exchange service principal'
$exoSp = Get-ServicePrincipal -ErrorAction SilentlyContinue | Where-Object { $_.AppId -eq $AppId } | Select-Object -First 1
if ($exoSp) {
    Write-Reuse "Exchange already knows this app (Identity $($exoSp.Identity))."
    if ($exoSp.ObjectId -and $exoSp.ObjectId -ne $SpObjectId) {
        Write-Warn2 "Its ObjectId ($($exoSp.ObjectId)) differs from the Entra service principal ($SpObjectId). It must be the ENTERPRISE APPLICATION object id. Fix by hand; not changing it."
    }
}
else {
    # -ObjectId must be the Enterprise Application (service principal) object id, NOT the app registration object id.
    $exoSp = New-ServicePrincipal -AppId $AppId -ObjectId $SpObjectId -DisplayName $AppName
    Write-Ok "Registered the service principal in Exchange (Identity $($exoSp.Identity))"
}

Write-Step "Management scope '$ScopeName'"
$filter = "PrimarySmtpAddress -eq '$($mbx.PrimarySmtpAddress)'"
$scope = Get-ManagementScope -Identity $ScopeName -ErrorAction SilentlyContinue
if ($scope) {
    Write-Reuse "Scope already exists with filter: $($scope.RecipientFilter)"
    if ($scope.RecipientFilter -notmatch [regex]::Escape([string]$mbx.PrimarySmtpAddress)) {
        Write-Warn2 "That filter does not mention $($mbx.PrimarySmtpAddress). Not changing it. Fix with:"
        Write-Warn2 "  Set-ManagementScope -Identity '$ScopeName' -RecipientRestrictionFilter `"$filter`""
    }
}
else {
    $scope = New-ManagementScope -Name $ScopeName -RecipientRestrictionFilter $filter
    Write-Ok "Created scope with filter: $filter"
}

Write-Step "Role assignment '$RoleName' limited to '$ScopeName'"
$assigneeIds = @($exoSp.Identity, $exoSp.ObjectId, $exoSp.AppId, $exoSp.DisplayName, $AppId, $SpObjectId) |
    Where-Object { $_ } | ForEach-Object { "$_" }
$existingAssignments = @(Get-ManagementRoleAssignment -Role $RoleName -ErrorAction SilentlyContinue |
    Where-Object { $assigneeIds -contains "$($_.RoleAssignee)" -or $assigneeIds -contains "$($_.RoleAssigneeName)" })
$scopedAssignment = $existingAssignments | Where-Object { "$($_.CustomResourceScope)" -eq $ScopeName } | Select-Object -First 1
if ($scopedAssignment) {
    Write-Reuse "Assignment already exists ($($scopedAssignment.Name))."
}
else {
    $newAssignment = New-ManagementRoleAssignment -App $AppId -Role $RoleName -CustomResourceScope $ScopeName
    Write-Ok "Created assignment ($($newAssignment.Name))"
}
$unscoped = @($existingAssignments | Where-Object { "$($_.CustomResourceScope)" -ne $ScopeName })
if ($unscoped.Count -gt 0) {
    Write-Warn2 "This app ALSO has $($unscoped.Count) other '$RoleName' assignment(s) not limited to '$ScopeName':"
    foreach ($a in $unscoped) { Write-Warn2 "  $($a.Name)  scope=$($a.CustomResourceScope)" }
    Write-Warn2 'Those may grant access to other mailboxes. This script will not remove them; review them by hand.'
}

# ---------------------------------------------------------------------------------------------------------
# 3. Verify
# ---------------------------------------------------------------------------------------------------------
Write-Step 'Verifying access (Test-ServicePrincipalAuthorization)'
function Show-AuthTest([string]$Resource, [bool]$Expected) {
    try {
        $rows = @(Test-ServicePrincipalAuthorization -Identity $AppId -Resource $Resource)
        $relevant = @($rows | Where-Object { "$($_.RoleName)" -eq $RoleName })
        if ($relevant.Count -eq 0) { $relevant = $rows }
        $inScope = [bool]($relevant | Where-Object { $_.InScope -eq $true })
        $rows | Format-Table RoleName, GrantedPermissions, AllowedResourceScope, ScopeType, InScope -AutoSize | Out-Host
        if ($inScope -eq $Expected) {
            Write-Ok "$Resource -> InScope = $inScope (expected $Expected)"
        }
        else {
            Write-Warn2 "$Resource -> InScope = $inScope (expected $Expected)"
        }
    }
    catch {
        Write-Warn2 "Test against $Resource failed: $($_.Exception.Message)"
    }
}

Write-Info "Support mailbox ($($mbx.PrimarySmtpAddress)) - should be IN scope:"
Show-AuthTest -Resource ([string]$mbx.PrimarySmtpAddress) -Expected $true

# Pick another mailbox to prove the scope excludes it: the signed-in admin's own, else any other mailbox.
$other = $null
if ($SignedInUpn -and $SignedInUpn -ne [string]$mbx.PrimarySmtpAddress) {
    $other = Get-EXOMailbox -Identity $SignedInUpn -ErrorAction SilentlyContinue
}
if (-not $other) {
    $other = Get-EXOMailbox -ResultSize 10 -RecipientTypeDetails UserMailbox -ErrorAction SilentlyContinue |
        Where-Object { $_.PrimarySmtpAddress -ne $mbx.PrimarySmtpAddress } | Select-Object -First 1
}
if ($other) {
    Write-Info "Another mailbox ($($other.PrimarySmtpAddress)) - should be NOT in scope:"
    Show-AuthTest -Resource ([string]$other.PrimarySmtpAddress) -Expected $false
}
else {
    Write-Warn2 'Could not find another mailbox to test the negative case.'
}

Write-Info 'Note: Test-ServicePrincipalAuthorization reads the configuration directly. The live Graph token can take'
Write-Info '      30 minutes to 2 hours to pick up a new role assignment, so FPX may report "access denied" until then.'

# ---------------------------------------------------------------------------------------------------------
# 4. Output
# ---------------------------------------------------------------------------------------------------------
$line = '=' * 78
Write-Host ''
Write-Host $line -ForegroundColor Cyan
Write-Host ' Paste these into FPX dashboard -> Admin -> Support Mailbox' -ForegroundColor Cyan
Write-Host $line -ForegroundColor Cyan
Write-Host "  Mailbox       : $($mbx.PrimarySmtpAddress)"
Write-Host "  Tenant ID     : $TenantId"
Write-Host "  Client ID     : $AppId"
Write-Host "  Client secret : $($secret.SecretText)" -ForegroundColor Yellow
Write-Host "  Secret expires: $($secret.EndDateTime.ToLocalTime().ToString('yyyy-MM-dd HH:mm')) (local time)"
Write-Host $line -ForegroundColor Cyan
Write-Host ' WARNING: the client secret is shown ONLY NOW. Microsoft will never show it again.' -ForegroundColor Red
Write-Host '          Paste it into FPX right away. Do not email it, put it in chat, or save it in a file.' -ForegroundColor Red
Write-Host '          If you lose it, just run this script again to get a new one.' -ForegroundColor Red
Write-Host ''
Write-Host ' Role assignments can take up to 2 hours to apply. If FPX says "access denied" right after'
Write-Host ' connecting, wait and press "Test connection" again.'
Write-Host " Set a reminder to rotate the secret before $($secret.EndDateTime.ToLocalTime().ToString('yyyy-MM-dd'))."
Write-Host $line -ForegroundColor Cyan

try { Disconnect-ExchangeOnline -Confirm:$false | Out-Null } catch { }
try { Disconnect-MgGraph | Out-Null } catch { }
