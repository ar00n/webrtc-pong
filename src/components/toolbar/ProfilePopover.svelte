<script>
  import { onDestroy } from 'svelte';
  import { copyToClipboard, downloadJsonFile } from '../../utils/dom.js';

  let { identity, onNicknameChange, onExportIdentity, onImportIdentity, onClose } = $props();

  let backupOpen = $state(false);
  let importJson = $state('');
  let backupFeedback = $state('');
  let copyBackupLabel = $state('Copy Backup JSON');
  let copyBackupTimer = null;

  let nicknameDraft = $state('');
  let nicknameFocused = $state(false);
  let lastNickname;

  onDestroy(() => {
    clearTimeout(copyBackupTimer);
  });

  $effect(() => {
    const current = identity.nickname;
    if (current !== lastNickname) {
      lastNickname = current;
      if (!nicknameFocused) {
        nicknameDraft = current;
      }
    }
  });

  function saveNickname(inputEl) {
    onNicknameChange(nicknameDraft);
    inputEl?.blur();
  }

  async function handleCopyBackup(e) {
    e.currentTarget.blur();
    const json = onExportIdentity() || '';
    const ok = await copyToClipboard(json);
    copyBackupLabel = ok ? 'Copied!' : 'Copy Failed';
    clearTimeout(copyBackupTimer);
    copyBackupTimer = setTimeout(() => {
      copyBackupLabel = 'Copy Backup JSON';
    }, 1400);
  }

  function handleDownloadBackup(e) {
    e.currentTarget.blur();
    const json = onExportIdentity() || '';
    const safeTag = identity.displayTag
      .replace('#', '-')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    downloadJsonFile(`pong-identity-${safeTag}.json`, json);
  }

  async function handleImportBackup(e) {
    e.currentTarget.blur();
    const raw = importJson.trim();
    if (!raw) {
      backupFeedback = 'Paste a backup JSON first.';
      return;
    }
    const res = await onImportIdentity(raw);
    if (res?.ok) {
      importJson = '';
      backupFeedback = `Restored identity: ${res.displayTag}`;
    } else {
      backupFeedback = res?.error || 'Restore failed.';
    }
  }
</script>

<div
  id="dropdownProfile"
  class="dropdown-popover"
  role="region"
  aria-label="Player Identity & Backup"
>
  <div class="popover-header">
    <span class="popover-title">Player Identity &amp; Key Backup</span>
    <button
      type="button"
      class="popover-close"
      aria-label="Close"
      onclick={(e) => {
        e.currentTarget.blur();
        onClose();
      }}
    >
      ×
    </button>
  </div>

  <div class="identity-bar">
    <label class="inline-field">
      <span class="field-label">Nickname</span>
      <input
        class="nickname-input"
        type="text"
        maxlength="20"
        placeholder="Nickname"
        aria-label="Nickname"
        bind:value={nicknameDraft}
        onfocus={() => (nicknameFocused = true)}
        onblur={() => (nicknameFocused = false)}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            saveNickname(e.currentTarget);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            nicknameDraft = identity.nickname;
            e.currentTarget.blur();
          }
        }}
      />
    </label>
    <button
      type="button"
      class="secondary small"
      onclick={(e) => {
        e.currentTarget.blur();
        saveNickname();
      }}
    >
      Set Name
    </button>
    <button
      type="button"
      class="secondary small"
      onclick={(e) => {
        e.currentTarget.blur();
        backupOpen = !backupOpen;
        backupFeedback = '';
      }}
    >
      Key Backup ▾
    </button>
  </div>

  {#if backupOpen}
    <div class="backup-panel">
      <div class="row">
        <button type="button" class="secondary small" onclick={handleDownloadBackup}>
          Download Key Backup
        </button>
        <button type="button" class="secondary small" onclick={handleCopyBackup}>
          {copyBackupLabel}
        </button>
      </div>
      <div class="row">
        <textarea
          rows="2"
          placeholder="Paste exported JSON backup here to restore your identity & history..."
          aria-label="Import identity backup JSON"
          bind:value={importJson}
        ></textarea>
        <button type="button" class="small" onclick={handleImportBackup}>
          Import Backup
        </button>
      </div>
      {#if backupFeedback}
        <p class="status backup-feedback">{backupFeedback}</p>
      {/if}
    </div>
  {/if}
</div>