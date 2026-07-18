(() => {
  const form = document.getElementById('start-form');
  if (!form) return;

  // Web3Forms relays submissions straight to an inbox with no backend of our own — this key just
  // says *where* to deliver, it isn't a secret credential (it's visible in page source by design).
  // Real abuse-resistance is the domain whitelist set in the Web3Forms dashboard for this key, not
  // keeping the key itself hidden. See the memory doc for the one-time dashboard setup this requires.
  const WEB3FORMS_ACCESS_KEY = '2d3d90f0-238d-430a-afb4-0db6890c5cde';
  const FALLBACK_EMAIL = 'sealpointagency@gmail.com';

  const submitBtn = form.querySelector('.startp-submit');
  const errorEl = document.getElementById('sp-error');
  const successEl = document.getElementById('sp-success');
  const introEl = document.getElementById('sp-intro');

  // Service tabs stand in for a <select> — a button group carries no native form-control value of its
  // own, so the picked tab's label is mirrored into this hidden input for the submit handler to read,
  // same as form.name/form.date read their own native inputs directly.
  const serviceTabs = document.getElementById('sp-service-tabs');
  const serviceInput = document.getElementById('sp-service');
  if (serviceTabs && serviceInput) {
    const allTabs = serviceTabs.querySelectorAll('.startp-tab');
    // With only one tab there's no real choice to make — pre-select it so the visitor isn't forced to
    // click a single obvious option before they can submit. Stays generic (checks the actual count
    // rather than hardcoding "Website") so adding more services back later just works.
    if (allTabs.length === 1) {
      allTabs[0].classList.add('is-active');
      serviceInput.value = allTabs[0].dataset.value;
    }
    serviceTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.startp-tab');
      if (!tab) return;
      allTabs.forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      serviceInput.value = tab.dataset.value;
      serviceTabs.classList.remove('is-invalid');
    });
  }

  function showError(message) {
    errorEl.innerHTML = `${message} Or email us directly at <a href="mailto:${FALLBACK_EMAIL}">${FALLBACK_EMAIL}</a>.`;
    errorEl.hidden = false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    // A hidden input can't use native `required` (browsers can't focus a hidden control to show the
    // validation UI, and Chrome throws outright) — this is the manual equivalent, only for the one
    // field that actually needs it.
    if (!serviceInput.value) {
      serviceTabs.classList.add('is-invalid');
      serviceTabs.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const name = form.name.value.trim();
    const service = serviceInput.value;
    const details = form.details.value.trim();
    const rawDate = form.date.value;
    // en-CA/ISO input value ("YYYY-MM-DD") has no time zone attached; parsing it plain would let the
    // browser assume UTC and can roll the displayed day back by one depending on the visitor's own
    // offset. Anchoring to local noon keeps the calendar day the visitor actually picked.
    const date = rawDate
      ? new Date(`${rawDate}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      : '';

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: WEB3FORMS_ACCESS_KEY,
          subject: `New project inquiry — ${name}`,
          from_name: name,
          name,
          service,
          available_day: date,
          details,
          botcheck: form.botcheck.checked,
        }),
      });
      const result = await res.json();

      if (result.success) {
        introEl.hidden = true;
        form.hidden = true;
        successEl.hidden = false;
        successEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        showError('Something went wrong sending this — please try again.');
      }
    } catch {
      showError('Something went wrong sending this — please try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
    }
  });
})();
