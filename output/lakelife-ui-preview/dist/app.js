/* Browser-only review state. Deliberately no storage, fetch, auth or production integration. */
window.LakeEscape = value => String(value ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
(() => {
  const initialState = () => ({confirmedExtra:0,report:{amount:100,method:'Cash at the office',date:'2026-10-15',status:'pending'},requests:[],seasonal:'suggested'});
  let state=initialState(), filter='all', search='', opener=null, toastTimer;
  const app=document.getElementById('app'), dialog=document.getElementById('dialog'), dialogContent=document.getElementById('dialog-content');
  const cash=LakePortals.cash, esc=LakeEscape;
  const validRoutes=['home','marketing','portal','services','for-parks','how-it-works','get-started','park','park/renters','park/money','park/onsite','park/lots','park/setup','park/onboard','park/documents','park/costs','park/statements','park/services','park/amenities','park/import','park/people','renter','renter/bills','renter/updates','renter/care','homeowner','homeowner/requests','homeowner/approvals','homeowner/messages','homeowner/property','homeowner/billing'];
  const names={home:'Your LakeLife, Automated.',marketing:'LakeLife for your park',portal:'Find your portal',services:'Lake-home services','for-parks':'For park owners','how-it-works':'How LakeLife works','get-started':'Ask for a walkthrough',park:'Park office',renter:'Renter portal',homeowner:'My lake home'};
  function route(){return location.hash.replace(/^#\/?/,'')||'home'}
  function render(focus=false){
    let r=route();
    if(!validRoutes.includes(r)){r='home';history.replaceState(null,'','#/home')}
    const [role,page]=r.split('/');
    const portal=['park','renter','homeowner'].includes(role);
    app.innerHTML=portal?LakePortals.render(role,page,state):LakePublic.render(role);
    document.title=`${names[role]||'LakeLife'} · Local design preview`;
    document.getElementById('preview-screen').value=role;
    document.body.classList.toggle('portal-view',portal);
    if(r==='park/renters'){filter='all';search=''}
    if(focus){window.scrollTo({top:0,behavior:'instant'});document.getElementById('main').focus({preventScroll:true})}
  }
  function toast(message){const t=document.getElementById('toast');t.textContent=message;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),5000)}
  function close(){dialog.close()}
  function open(title,body,actions=''){
    if(!dialog.open)opener=document.activeElement;
    dialogContent.innerHTML=`<h2 id="dialog-title" tabindex="-1">${title}</h2>${body}${actions?`<div class="dialog-actions">${actions}</div>`:''}`;
    if(!dialog.open)dialog.showModal();
    dialogContent.scrollTop=0;
    document.getElementById('dialog-title').focus();
  }
  const doneButton='<button class="button small" data-action="close">Done</button>';
  const backButton='<button class="button light small" data-action="close">Cancel</button>';
  function showPayment(){
    const r=state.report, isOwner=route().startsWith('park');
    if(!r){open('No payment report to review.','<p class="intro">You can report a payment already made through your park’s usual payment method.</p>',doneButton);return}
    open(r.status==='pending'?'A reported payment. Not a receipt yet.':'Payment record confirmed.',`<p class="intro">Alex Morgan · Lakeside Park · Lot 01 · Example record</p><div class="statement-row"><span>Amount reported</span><b>${cash(r.amount)}</b></div><div class="statement-row"><span>Reported method</span><b>${esc(r.method)}</b></div><div class="statement-row"><span>Reported date</span><b>${esc(r.date)}</b></div><div class="statement-row"><span>Status</span><span class="pill ${r.status==='pending'?'gold':'green'}">${r.status==='pending'?'Awaiting office review':'Confirmed in this example'}</span></div><p class="panel-note">${r.status==='pending'?'The balance has not changed. The park office must check its records before confirming a receipt.':'The example bill now includes this confirmed record. No payment was collected or transferred.'}</p>`,r.status==='pending'&&isOwner?`${backButton}<button class="button small" data-action="confirm-payment">Confirm example receipt →</button>`:doneButton);
  }
  function serviceForm(service='Seasonal care',seasonal=false){
    const services=['Seasonal care','Piers & lifts','Lawn care','Housekeeping'];
    if(!services.includes(service))service='Seasonal care';
    open(seasonal?'Review your seasonal suggestion.':'What needs a little care?',`<p class="intro">Choose a preferred date and a few details. In this sample workflow, the request will need a quote and scheduling confirmation.</p><form id="service-form" data-seasonal="${seasonal}"><div class="field"><label for="service-kind">Service</label><select id="service-kind" name="service">${services.map(s=>`<option ${s===service?'selected':''}>${s}</option>`).join('')}</select></div><div class="field"><label for="service-date">Preferred date</label><input id="service-date" name="date" type="date" required value="${seasonal?'2026-11-02':'2026-10-30'}"><small>A preferred date is a request, not a confirmed appointment.</small></div><div class="field"><label for="service-note">Anything to know?</label><textarea id="service-note" name="note" maxlength="500" placeholder="Use sample details only."></textarea></div><div class="panel-note">Price pending. This preview cannot check crew availability or lake-season dates, book work or charge a card.</div><div class="dialog-actions">${backButton}<button class="button small" type="submit">Create example request →</button></div></form>`);
  }
  function onAction(name,el){
    switch(name){
      case 'menu':{const nav=document.getElementById('public-nav');const expanded=el.getAttribute('aria-expanded')==='true';el.setAttribute('aria-expanded',String(!expanded));nav.classList.toggle('open',!expanded);break}
      case 'close':close();break;
      case 'review-payment':showPayment();break;
      case 'confirm-payment':{
        if(!route().startsWith('park')||state.report?.status!=='pending')return;
        state.confirmedExtra+=state.report.amount;state.report.status='confirmed';render();
        open('Example receipt confirmed.','<div class="result-mark" aria-hidden="true">✓</div><p class="intro">The sample rent roll and renter bill now reflect the confirmed record. No money moved.</p><p class="panel-note teal">Use the preview selector to open the renter portal and see the same updated balance. Reset demo restores the original records.</p>',doneButton);break;
      }
      case 'report-payment':open('Already paid your park?',`<p class="intro">This reports a payment you made outside the portal. The office still needs to review it.</p><form id="payment-report-form"><div class="form-grid"><div class="field"><label for="report-amount">Amount paid ($)</label><input id="report-amount" name="amount" type="number" inputmode="decimal" min="1" max="${415-state.confirmedExtra}" step="1" value="50" required></div><div class="field"><label for="report-date">Date paid</label><input id="report-date" name="date" type="date" value="2026-10-17" required></div></div><div class="field"><label for="report-method">How did you pay?</label><select id="report-method" name="method"><option>Cash at the office</option><option>Check to the park</option><option>Other park-arranged method</option></select></div><div class="panel-note">Reporting this payment does not reduce the balance. No payment will be collected in this preview.</div><div class="dialog-actions">${backButton}<button class="button small" type="submit">Create example report →</button></div></form>`);break;
      case 'payment-options':
      case 'office-contact':open('Pay through your park’s usual method.','<p class="intro">Online payments are unavailable in this preview. Contact your park office for its accepted payment methods and instructions.</p><div class="panel-note">If you already paid outside the portal, report the payment for office review. A report alone is not a confirmed receipt.</div><p class="small-copy muted" style="margin-top:18px">No payment credentials or contact details are connected to this fictional park.</p>',doneButton);break;
      case 'resident':{
        const r=LakePortals.rentRows(state).find(r=>r.lot===el.dataset.lot);if(!r)return;
        open(`${esc(r.name)} · Lot ${r.lot}`,`<p class="intro">October 2026 · Sample resident record</p><div class="statement-row"><span>Charges</span><b>${cash(r.charge)}</b></div><div class="statement-row"><span>Confirmed receipts</span><b>${cash(r.paid)}</b></div><div class="statement-row total"><span>Balance due</span><b>${cash(r.charge-r.paid)}</b></div>${r.pending?`<p class="panel-note">${cash(r.pending)} reported payment still needs office review.</p>`:''}`,r.pending?`<button class="button small" data-action="review-payment">Review payment report →</button>`:doneButton);break;
      }
      case 'take-payment':open('Record money already received.','<p class="intro">The existing park workflow lets the office find a household and record an offline payment it has received.</p><div class="statement-row"><span>1. Find the household</span><b>Name or lot</b></div><div class="statement-row"><span>2. Review the receipt details</span><b>Amount, method & date</b></div><div class="statement-row"><span>3. Record the receipt</span><b>Keep the real record</b></div><p class="panel-note">This preview keeps the entry point visible but cannot record a real payment. Recording an offline receipt is not charging a card.</p>',doneButton);break;
      case 'water-source':open('The water charge, explained.','<p class="intro">October 2026 · Synthetic billing example</p><div class="statement-row"><span>Example utility source total</span><b>$60</b></div><div class="statement-row"><span>Eligible occupied lots</span><b>4</b></div><div class="statement-row total"><span>Equal share per lot</span><b>$15</b></div><p class="panel-note teal">This example uses equal allocation. Actual bills follow configured park rules. There is no real utility invoice attached to this preview.</p>',doneButton);break;
      case 'issues':open('Open issues around the park.','<p class="intro">Two fictional records. These statuses do not promise a repair date.</p><div class="statement-row"><span><b>Lot 01 · Water connection</b><br>Office recorded the report on Oct 16.</span><span class="pill gold">In review</span></div><div class="statement-row"><span><b>Lot 03 · Path light</b><br>Issue recorded on Oct 15.</span><span class="pill">Open</span></div>',doneButton);break;
      case 'resident-issue':open('Water at your lot connection.','<p class="intro">Lot 01 · Example issue record</p><div class="journey-list"><div class="journey-row done"><span class="journey-dot">✓</span><div><b>Report recorded · Oct 16</b><p>Water reported at the lot connection.</p></div></div><div class="journey-row"><span class="journey-dot">2</span><div><b>Office review</b><p>The office has the report. No confirmed repair date is recorded.</p></div></div></div><p class="panel-note teal">This view shows the recorded status. It does not confirm that a notification was delivered or repair work was scheduled.</p>',doneButton);break;
      case 'request-service':serviceForm(el.dataset.service);break;
      case 'seasonal':{
        if(state.seasonal!=='suggested'){open(state.seasonal==='skipped'?'Suggestion skipped.':'Seasonal request recorded.',`<p class="intro">${state.seasonal==='skipped'?'No booking was made. The original example can be restored using Reset demo.':'The example request is awaiting a quote and schedule confirmation. Nothing was booked or charged.'}</p>`,doneButton);break}
        open('A suggestion for the season ahead.','<p class="intro">Seasonal closing · Suggested date: November 02, 2026</p><p class="small-copy">You decide whether to request this visit or skip it. The suggestion has not booked work, accepted a quote or charged a payment method.</p><p class="panel-note teal">A requested date still needs to be confirmed. Price and crew availability are checked in the actual service workflow.</p>','<button class="button light small" data-action="skip-seasonal">Skip this suggestion</button><button class="button small" data-action="request-seasonal">Review request →</button>');break;
      }
      case 'skip-seasonal':state.seasonal='skipped';render();open('Suggestion skipped.','<p class="intro">The example now shows your choice. No booking was created.</p>',doneButton);break;
      case 'request-seasonal':serviceForm('Seasonal care',true);break;
      case 'correction':open('Review the pier detail.','<p class="intro">The crew proposed a change. Your current profile and agreed record remain intact.</p><div class="statement-row"><span>Current profile</span><b>8 sections</b></div><div class="statement-row"><span>Proposed correction</span><b>10 sections</b></div><p class="panel-note">No price change is calculated in this preview. The actual approval flow must use the current pricing rules and preserve agreed exceptions.</p><p class="small-copy muted" style="margin-top:18px">Design review: this screen intentionally stops before approval. The earlier audit found that updating the profile and repricing are separate operations; this UI does not claim they succeed together.</p>',doneButton);break;
    }
  }
  document.addEventListener('click',e=>{
    const trigger=e.target.closest('[data-action]');if(trigger){onAction(trigger.dataset.action,trigger);return}
    const filterButton=e.target.closest('[data-filter]');if(filterButton){filter=filterButton.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>{b.classList.toggle('active',b===filterButton);b.setAttribute('aria-pressed',String(b===filterButton))});document.getElementById('rent-results').innerHTML=LakePortals.rollTable(state,filter,search)}
    const routeLink=e.target.closest('a[href^="#/"]');if(routeLink&&dialog.open)close();
  });
  document.addEventListener('input',e=>{if(e.target.id==='resident-search'){search=e.target.value;document.getElementById('rent-results').innerHTML=LakePortals.rollTable(state,filter,search)}});
  document.addEventListener('submit',e=>{
    const f=e.target;if(!['walkthrough-form','service-form','payment-report-form','message-draft-form'].includes(f.id))return;
    e.preventDefault();if(!f.reportValidity())return;
    const d=new FormData(f);
    if(f.id==='message-draft-form'){open('Your message draft.',`<p class="intro">This is an on-screen draft. Nothing was sent to LakeLife or a crew.</p><p class="panel-note teal" style="white-space:pre-wrap">${esc(d.get('message'))}</p>`,doneButton)}
    if(f.id==='walkthrough-form'){
      open('Your walkthrough draft.',`<p class="intro">Prepared for review only. Nothing has been sent or saved.</p><div class="statement-row"><span>Name</span><b>${esc(d.get('name'))}</b></div><div class="statement-row"><span>Email</span><b class="wrap-anywhere">${esc(d.get('email'))}</b></div><div class="statement-row"><span>Audience</span><b>${esc(d.get('role'))}</b></div><p class="small-copy" style="margin-top:20px;white-space:pre-wrap">${esc(d.get('note'))||'No extra notes.'}</p><p class="panel-note teal">This is the proposed form experience. A production contact destination needs to be connected and checked before this page can receive real requests.</p>`,doneButton);
    }
    if(f.id==='service-form'){
      const date=new Date(`${d.get('date')}T12:00:00`);if(!Number.isFinite(date.getTime()))return;
      state.requests.push({audience:route().startsWith('renter')?'renter':'homeowner',service:String(d.get('service')),date:date.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+' requested',price:'Price pending',status:'Requested'});
      if(f.dataset.seasonal==='true')state.seasonal='requested';
      const isRenter=route().startsWith('renter');render();
      open('Example request created.','<div class="result-mark" aria-hidden="true">✓</div><p class="intro">Price pending. Preferred date not confirmed. This is a local example only; no crew has received a request.</p>',`<a class="button small" href="#/${isRenter?'renter/care':'homeowner/requests'}">View example requests →</a>`);
    }
    if(f.id==='payment-report-form'){
      const amount=Number(d.get('amount'));if(!Number.isInteger(amount)||amount<1||amount>415-state.confirmedExtra||state.report?.status==='pending')return;
      state.report={amount,method:String(d.get('method')),date:String(d.get('date')),status:'pending'};render();
      open('Example report awaiting review.','<div class="result-mark" aria-hidden="true">✓</div><p class="intro">Your sample balance has not changed. The park office still needs to check and confirm the payment record.</p><p class="panel-note teal">No payment was collected and no notification was sent.</p>',doneButton);
    }
  });
  document.getElementById('close-dialog').addEventListener('click',close);
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()}});
  dialog.addEventListener('close',()=>{if(opener?.isConnected)opener.focus();else document.getElementById('main')?.focus({preventScroll:true})});
  document.getElementById('preview-screen').addEventListener('change',e=>{location.hash='/'+e.target.value});
  document.getElementById('reset-preview').addEventListener('click',()=>{if(dialog.open)close();state=initialState();filter='all';search='';render();toast('Sample records reset. Nothing was changed outside this preview.')});
  window.addEventListener('hashchange',()=>{if(dialog.open)close();render(true)});
  render();
})();
