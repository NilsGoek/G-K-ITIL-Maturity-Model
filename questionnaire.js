import { getAssessmentQuestions, selectedPracticeIds, makePendingResponse, invalidateResponse,
  answerFinding, responseOpenReason, questionAnswerIsSelected, markQuestionAnswerSelection, questionAnswerHelp, questionAnswerStatus, questionAnswerLabel } from './catalogs.js';
import { evaluate } from './scoring.js';
import {resubmitSimpleAnswer} from './answer-reconfirmation.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
const statusLabel = value => ({ confirmed:'Stufe bestimmt', provisional:'Vorläufige Stufe', open:'Noch offen',
  partial_scope:'Umfang noch offen', below_baseline:'Ausgangsstufe nicht erfüllt', needs_reconciliation:'Antworten widersprüchlich',
  not_classifiable:'Noch nicht einstufbar' }[value] || 'Noch offen');
const optionTags = (options,value,empty = null) => `${empty == null ? '' : `<option value="">${esc(empty)}</option>`}${options.map(o => `<option value="${esc(o.id)}"${o.id === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}`;

/** Separate known question introductions for display while preserving source questions. */
export function splitQuestionText(question) {
  const text = String(question?.text ?? '');
  let introduction = '',prompt = text;
  const practicePrefix = question?.practiceId && question.criterionTitle && Number.isInteger(question.level)
    ? `${question.criterionTitle} – Stufe ${question.level}:` : null;
  if (practicePrefix && prompt.startsWith(practicePrefix)) {
    introduction = practicePrefix;
    prompt = prompt.slice(practicePrefix.length).trimStart();
  }
  const lead = ['Ist folgende Anforderung erfüllt:',
    'Ist folgendes Merkmal für diesen einzelnen Aspekt nachgewiesen:',
    'Sind für die Kategorie folgende Voraussetzungen vollständig nachgewiesen:']
    .find(value => prompt.startsWith(value));
  if (lead) {
    introduction += `${introduction ? ' ' : ''}${lead}`;
    prompt = prompt.slice(lead.length).trimStart();
  }
  return prompt ? {introduction,prompt} : {introduction:'',prompt:text};
}

/** Submitted self-assessment answers contain no invented evidence review. */
export function updateResponse(record,questionId,changes) {
  let response = record.responses.find(row => row.question_id === questionId);
  if (!response) { response = makePendingResponse(questionId); record.responses.push(response); }
  const fields = new Set(['answer','finding','evidence_status','evidence_ids','check_results','assessor_rationale','reviewer_id']);
  for (const [key,value] of Object.entries(changes)) {
    if (!fields.has(key)) throw new Error(`Nicht erlaubtes Antwortfeld: ${key}.`);
    response[key] = key === 'check_results' ? value.map(check => ({ ...check,rationale:check.rationale ?? '' })) : value;
  }
  if (Object.hasOwn(changes,'answer')) {
    response.finding = answerFinding(response.answer); response.review_status = 'approved';
    response.evidence_status = 'not_checked'; response.reviewer_id = null; response.reviewed_at = null;
  }
  return response;
}

export function submitSimpleAnswer(record,questionId,answer,ui = {}) {
  const selected = ['yes','partial','no','unknown'].includes(answer);
  markQuestionAnswerSelection(ui,questionId,selected);
  const response = updateResponse(record,questionId,{ answer:selected ? answer : 'unknown',check_results:[] });
  if (!selected) invalidateResponse(response);
  return response;
}

export function canResubmitAnswer(response,ui = {}) {
  return Boolean(response?.review_status === 'pending' && questionAnswerIsSelected(response,ui) &&
    ['yes','partial','no','unknown'].includes(response.answer));
}

/** Actionable domain prerequisites remain separate from the stored question answers. */
export function buildComponentBlocker(payload,result,componentId) {
  const component = result?.component_results?.[componentId];
  if (componentId === 'service_value_chain' && component?.status === 'partial_scope') return {
    kind:'svc_scope',title:'Wertstromumfang noch nicht vollständig',
    text:'Für die SVC-Stufe ist ein vollständiges Wertstrominventar mit bestätigter Abdeckung erforderlich. Bitte unter „Projekt & Umfang“ alle wesentlichen Wertströme erfassen, deren Untersuchung angeben und die Abdeckung bestätigen. Deine Frageantworten bleiben gespeichert.',
    actions:[{ label:'Wertströme & Umfang festlegen',route:'context' }],
  };
  const selected = selectedPracticeIds(payload); const pr02Included = selected.includes('PR02');
  if (componentId === 'practices' && component?.status === 'partial_scope') return {
    kind:'practice_scope',title:'Practice-Auswahl oder Rollen noch offen',
    text:'Die Practices-Kategorie benötigt eine abgeschlossene Auswahl, mindestens eine Schlüssel-Practice, die erforderlichen unterstützenden Practices und PR02 Continual Improvement. Bitte die Auswahl und Rollen vollständig festlegen und bestätigen. Die einzelnen Practice-Antworten und Fähigkeitsnoten bleiben erhalten.',
    actions:[{ label:'Practice-Auswahl abschließen',route:'practices' },...(pr02Included ? [{ label:'PR02 bewerten',practiceId:'PR02' }] : [])],
  };
  const pr02 = result?.practice_results?.PR02;
  if (componentId === 'continual_improvement' && component && (component.dependency_status === 'pending' || pr02?.assessed_level == null)) {
    const scopePending = component.dependency_status === 'pending';
    const capability = pr02?.status === 'below_baseline'
      ? 'Die Ausgangsstufe von PR02 ist nach deinen bisherigen Antworten nicht erfüllt.'
      : pr02?.assessed_level == null ? 'PR02 besitzt noch keine Fähigkeitsnote; bitte die Basisfrage und die erforderlichen Einzelaspekte beantworten.' : '';
    return {
      kind:'ci_pr02',title:scopePending ? 'CI benötigt eine passende PR02-Bewertung' : 'PR02-Fähigkeit für CI noch nicht bestimmt',
      text:`Die CI-Kategorie benötigt zusätzlich PR02 Continual Improvement im gleichen Umfang und Zeitraum sowie eine abgeschlossene Practice-Auswahl. ${capability} Die vorhandenen CI-Antworten bleiben gespeichert und zählen, sobald diese Voraussetzung erfüllt ist.`,
      actions:[{ label:pr02Included ? 'Auswahl & Rollen prüfen' : 'PR02 auswählen',route:'practices' },...(pr02Included ? [{ label:'PR02 jetzt bewerten',practiceId:'PR02' }] : []),...(scopePending ? [{ label:'Umfang & Zeitraum prüfen',route:'context' }] : [])],
    };
  }
  return null;
}

function componentBlockerHtml(blocker) {
  if (!blocker) return '';
  return `<section class="notice component-blocker" role="status"><h2>${esc(blocker.title)}</h2><p>${esc(blocker.text)}</p><div class="actions">${blocker.actions.map(action => `<button type="button" class="btn ${action.practiceId ? 'btn-primary' : 'btn-secondary'}"${action.route ? ` data-route="${esc(action.route)}"` : ''}${action.practiceId ? ` data-practice="${esc(action.practiceId)}"` : ''}>${esc(action.label)}</button>`).join('')}</div></section>`;
}

export function consistencyNotesHtml(notes = []) {
  const messages = notes.map(note => typeof note === 'string' ? note : note?.message || note?.text || '').filter(Boolean);
  if (!messages.length) return '';
  return `<section class="consistency-note" aria-label="Einordnung der Antworten"><h2>Hinweis zu den Antworten</h2><ul>${messages.map(message => `<li>${esc(message)}</li>`).join('')}</ul><p>Die Einordnungsnotiz ändert die erreichte Stufe nicht. Deine ursprünglichen Antworten und die vollständigen Fragetexte bleiben erhalten.</p></section>`;
}

export function reviewResponse(record,question) {
  const row = record.responses.find(response => response.question_id === question.id);
  if (!row) return { ok:false,errors:['Bitte eine Antwort auswählen.'] };
  updateResponse(record,question.id,{ answer:row.answer });
  return { ok:true,errors:[] };
}

function actualQuestionState(questionId,unit) {
  if (Object.hasOwn(unit?.fulfilled_question_levels || {},questionId)) return 'fulfilled';
  if (unit?.blocking_question_ids?.includes(questionId)) return 'not_fulfilled';
  return 'open';
}

/** Stage counts come from the scorer, not from dropdowns or the whole library. */
export function buildStageOverview(catalogs,payload,result,ui,questionId = null) {
  const componentId = ui.componentId || 'guiding_principles';
  if (componentId !== 'practices') {
    const component = result?.component_results?.[componentId]; const seen = new Set();
    return (component?.component_level_evaluations || []).map(row => {
      const introduced = row.required_question_ids.filter(id => !seen.has(id));
      if (!row.initial_classification_only) row.required_question_ids.forEach(id => seen.add(id));
      const states = row.requirement_states || {}; const dependencies = row.dependency_requirements || [];
      const required = row.required_question_ids || [];
      return { level:row.level,initialClassification:Boolean(row.initial_classification_only),
        introducedQuestionIds:introduced,requiredQuestionIds:required,
        introducedFulfilledCount:introduced.filter(id => states[id] === 'fulfilled').length,
        fulfilledCount:required.filter(id => states[id] === 'fulfilled').length,totalCount:required.length,
        fulfilled:row.fulfilled,possible:row.possible,
        openQuestionIds:required.filter(id => states[id] === 'open'),
        blockingQuestionIds:required.filter(id => states[id] === 'not_fulfilled'),requirementStates:states,
        dependencies,pendingDependencies:dependencies.filter(dependency => dependency.state !== 'fulfilled') };
    });
  }
  const practice = catalogs.practices.find(p => p.id === ui.practiceId);
  if (!practice) return [];
  const questions = catalogs.adaptPractice(practice.id); const question = questions.find(q => q.id === questionId);
  const criterion = practice.module.criteria.find(c => c.id === question?.criterion_id) || practice.module.criteria[0];
  const practiceResult = result?.practice_results?.[practice.id];
  const unit = practiceResult?.unit_results?.find(row => row.unit_id === criterion.id) || practiceResult;
  const baseline = practice.module.criteria.find(c => c.category_id === 'PC01');
  const stages = criterion.category_id === 'PC01' ? criterion.level_requirements : [
    { level:1,question_ids:baseline.level_requirements.flatMap(stage => stage.question_ids) },...criterion.level_requirements ];
  const cumulative = [];
  return stages.map(stage => {
    cumulative.push(...stage.question_ids);
    const states = Object.fromEntries(cumulative.map(id => [id,actualQuestionState(id,unit)]));
    const blocking = cumulative.filter(id => states[id] === 'not_fulfilled'); const open = cumulative.filter(id => states[id] === 'open');
    return { level:stage.level,initialClassification:false,introducedQuestionIds:stage.question_ids,
      requiredQuestionIds:[...cumulative],introducedFulfilledCount:stage.question_ids.filter(id => states[id] === 'fulfilled').length,
      fulfilledCount:cumulative.filter(id => states[id] === 'fulfilled').length,totalCount:cumulative.length,
      fulfilled:open.length === 0 && blocking.length === 0,possible:blocking.length === 0,
      openQuestionIds:open,blockingQuestionIds:blocking,requirementStates:states,dependencies:[],pendingDependencies:[],
      ratingSource:unit?.rating_source,criterionId:criterion.id,criterionTitle:criterion.name || criterion.title };
  });
}

function explanationHtml(catalogs,payload,result,ui,question) {
  const practice = ui.componentId === 'practices';
  const unit = practice ? result?.practice_results?.[ui.practiceId] : result?.component_results?.[ui.componentId];
  const stages = buildStageOverview(catalogs,payload,result,ui,question?.id);
  const nextStage = stages.find(stage => !stage.initialClassification && !stage.fulfilled && stage.level > (unit?.assessed_level || 0));
  const lower = unit?.assessed_level;
  const description = practice
    ? 'Jeder Einzelaspekt besitzt eine eigene Stufenleiter. Die Practice-Note ist der abgerundete Durchschnitt aller erforderlichen Einzelnoten. Ein schwächerer Einzelaspekt beendet die anderen Leitern nicht.'
    : 'Eine Kategorie erreicht die höchste Stufe, deren sämtliche zutreffenden Voraussetzungen und positive Grundlagen erfüllt sind. Eine einzelne Ja-Antwort ergibt deshalb nicht automatisch eine höhere Kategorie-Stufe.';
  let current = lower == null ? 'Noch keine Stufe bestimmt.' : practice ? `Practice-Note ${lower} ergibt sich aus den erforderlichen Einzelnoten.` : `Stufe ${lower} ist nach den bisherigen Antworten vollständig erreicht.`;
  if (!practice && lower===1 && stages.some(stage=>stage.initialClassification&&stage.fulfilled)) current='Die Antworten ordnen die Kategorie dem beschriebenen Anfangszustand auf Stufe 1 zu.';
  if (unit?.status === 'partial_scope') current = 'Für einen Kategorienwert muss zuerst der Bewertungsumfang vollständig festgelegt sein.';
  if (unit?.status === 'needs_reconciliation') current = 'Die Antworten enthalten einen fachlichen Widerspruch, der zunächst geklärt werden muss.';
  if (unit?.status === 'below_baseline') current = 'Die definierte Ausgangsstufe ist nach den bisherigen Antworten nicht erfüllt.';
  if (practice && unit?.unrounded_mean != null) current += ` Exakter Wert: ${unit.unrounded_mean.toLocaleString('de-DE',{maximumFractionDigits:2})}; abgerundet: ${lower}.`;
  return `<details class="stage-overview"><summary>Stufenanforderungen anzeigen</summary><div class="stage-overview-content"><p>${esc(current)}</p><p class="muted small">${esc(description)}</p>
    ${nextStage && !practice ? `<p class="notice neutral">Für Stufe ${nextStage.level}: ${nextStage.fulfilledCount} von ${nextStage.totalCount} bisherigen Frage-Voraussetzungen erfüllt${nextStage.pendingDependencies.length ? `; zusätzlich ${nextStage.pendingDependencies.length} abhängige Voraussetzung offen oder nicht erfüllt` : ''}. ${nextStage.blockingQuestionIds.length ? 'Mindestens eine Voraussetzung ist derzeit nicht erfüllt.' : nextStage.openQuestionIds.length ? 'Die übrigen Voraussetzungen sind noch offen.' : ''}</p>` : ''}
    ${practice && ['reviewed_criterion_rating','self_assessed_criterion_rating'].includes(stages[0]?.ratingSource) ? '<p class="notice neutral">Für diesen Einzelaspekt wurde eine direkte Einzelnote anhand seiner eigenen Anker gewählt. Zugeordnete Stufenfragen bleiben zur Orientierung sichtbar.</p>' : ''}
    <div class="stage-overview-list">${stages.map(stage => `<details class="stage-overview-item"${stage.level === question?.level ? ' open' : ''}><summary><strong>${stage.initialClassification ? 'Anfangsklassifikation' : `Stufe ${stage.level}`}</strong><span class="badge">${stage.introducedFulfilledCount} / ${stage.introducedQuestionIds.length} ${stage.initialClassification ? 'zugeordnet' : 'zusätzliche Fragen erfüllt'}</span>${stage.fulfilled ? '<span class="stage-state">'+(stage.initialClassification?'Anfangszustand zugeordnet':'Erfüllt')+'</span>' : stage.blockingQuestionIds.length ? '<span class="stage-state">'+(stage.initialClassification?'Trifft nicht vollständig zu':'Voraussetzung nicht erfüllt')+'</span>' : '<span class="stage-state">Noch offen</span>'}</summary>
      <p class="muted small">${stage.initialClassification ? 'Beschreibt einen Anfangszustand und ist keine Voraussetzung höherer Stufen.' : `Zusammen mit den positiven Grundlagen: ${stage.fulfilledCount} von ${stage.totalCount} Frage-Voraussetzungen erfüllt.`}</p>
      <ul>${stage.introducedQuestionIds.map(id => { const q = catalogs.questionsById.get(id); const state = stage.requirementStates[id]; return `<li><button type="button" class="btn btn-quiet" data-question="${esc(id)}">${esc(ui.conversation ? q?.text || id : `${id} · ${q?.text || ''}`)}</button><span class="badge">${state === 'fulfilled' ? (stage.initialClassification?'Trifft zu':'Erfüllt') : state === 'not_fulfilled' ? (stage.initialClassification?'Trifft nicht vollständig zu':'Nicht erfüllt') : 'Offen'}</span></li>`; }).join('')}</ul>
      ${stage.dependencies.length ? `<p class="muted small">Zusätzliche Abhängigkeiten: ${stage.dependencies.map(d => `${esc(d.source_id)} mindestens ${d.minimum_level} · ${d.state === 'fulfilled' ? 'erfüllt' : d.state === 'not_fulfilled' ? 'nicht erfüllt' : 'offen'}`).join('; ')}.</p>` : ''}
    </details>`).join('')}</div>${unit?.limitations?.length ? `<details><summary>Weitere offene Bedingungen</summary><ul>${unit.limitations.map(text => `<li>${esc(text)}</li>`).join('')}</ul></details>` : ''}</div></details>`;
}

export function renderQuestionnaire(container,options) {
  const { catalogs,payload,result,ui,onChange = () => {},onNavigate = () => {},onEvidence,onDefer } = options;
  ui.selfAssessment = true;
  const componentId = ui.componentId || 'guiding_principles'; ui.componentId = componentId;
  const component = catalogs.components.find(c => c.id === componentId); const record = payload.assessments[componentId];
  const selected = selectedPracticeIds(payload);
  if (componentId === 'practices' && (!ui.practiceId || !selected.includes(ui.practiceId))) ui.practiceId = selected[0] || null;
  const practice = catalogs.practices.find(p => p.id === ui.practiceId);
  const currentResult = componentId === 'practices' ? result?.practice_results?.[ui.practiceId] : result?.component_results?.[componentId];
  const mode = ui.mode || 'required'; const worklist = getAssessmentQuestions(catalogs,payload,{ ...ui,componentId,mode },result);
  const responseOf = id => record.responses.find(row => row.question_id === id); const isOpen = q => responseOpenReason(responseOf(q.id),record,ui);
  const question = worklist.find(q => q.id === ui.questionId) || worklist.find(isOpen) || worklist[0];
  if (question) { ui.questionId = question.id; ui.groupId = question.groupId; }
  const groupQuestions = question ? worklist.filter(q => q.groupId === question.groupId && q.practiceId === question.practiceId) : [];
  const groups = [...new Map(worklist.map(q => [q.groupId,{ id:q.groupId,title:q.groupTitle }])).values()]; const pendingCount = worklist.filter(isOpen).length;
  const role = record.extensions.scope_decisions?.find(row => row.practice_id === ui.practiceId)?.scope_role;
  const navigate = changes => onNavigate(changes); const change = (reason,questionId = question?.id) => onChange({ reason,componentId,questionId });
  const localConsistencyNotes = Array.isArray(currentResult?.consistency_notes) ? currentResult.consistency_notes : [];
  const globalConsistencyNotes = componentId === 'guiding_principles' && Array.isArray(result?.consistency_notes) ? result.consistency_notes : [];
  const consistencyNotes = [...new Set([...localConsistencyNotes,...globalConsistencyNotes])];
  container.innerHTML = `<div class="assessment-heading section-title"><div><span class="eyebrow">SVS Assessment</span><h1>${esc(componentId === 'practices' && practice ? practice.name_de : component.label)}</h1><p class="muted">Antwort auswählen. Die Stufe wird direkt aktualisiert.</p></div><div class="assessment-heading-score"><strong>${currentResult?.assessed_level ?? '—'}</strong><span>${esc(statusLabel(currentResult?.status))}</span></div></div>
    ${componentBlockerHtml(buildComponentBlocker(payload,result,componentId))}
    ${consistencyNotesHtml(consistencyNotes)}
    <div class="component-tabs" role="group" aria-label="SVS-Bereich">${catalogs.components.map(c => `<button class="btn ${c.id === componentId ? 'btn-primary active' : 'btn-secondary'}" data-component="${c.id}" aria-pressed="${c.id === componentId}">${esc(c.label)}</button>`).join('')}</div>
    ${componentId === 'practices' ? `<div class="card practice-selector"><label class="field">Einbezogene Practice<select id="assessment-practice">${selected.map(id => { const p = catalogs.practices.find(p => p.id === id); return `<option value="${id}"${id === ui.practiceId ? ' selected' : ''}>${id} · ${esc(p.name_de)}</option>`; }).join('')}</select></label>${practice ? `<p class="muted">${esc(practice.purpose)} <span class="badge">${role === 'primary' ? 'Schlüssel-Practice' : role === 'supporting' ? 'Unterstützende Practice' : 'Rolle noch offen'}</span></p>` : '<p class="notice">Bitte zuerst Practices auswählen. PR02 Continual Improvement ist für das vollständige SVS erforderlich.</p>'}</div>` : ''}
    <div class="question-toolbar"><div class="view-switch" role="group" aria-label="Fragenumfang"><button class="btn ${mode === 'required' ? 'btn-primary active' : 'btn-secondary'}" data-mode="required">Erforderliche Fragen</button><button class="btn ${mode === 'all' ? 'btn-primary active' : 'btn-secondary'}" data-mode="all">Alle Fragen & Entwicklung</button><button class="btn ${mode === 'detail' ? 'btn-primary active' : 'btn-secondary'}" data-mode="detail">Optionale Einzelnoten</button><button class="btn btn-secondary" id="conversation-toggle" aria-pressed="${Boolean(ui.conversation)}">${ui.conversation ? 'Detailansicht' : 'Gesprächsansicht'}</button></div><p class="muted">${worklist.length - pendingCount} Fragen eingeordnet · ${pendingCount} noch offen im aktuellen Arbeitsumfang</p></div>
    ${question ? `<div class="question-layout${ui.conversation ? ' conversation-mode' : ''}"${ui.conversation ? ' style="grid-template-columns:minmax(0,1fr)"' : ''}>${ui.conversation ? '' : `<aside class="card question-index"><span class="eyebrow">Thema & Stufe</span><label class="field">Thema<select id="assessment-group">${optionTags(groups.map(g => ({ id:g.id,label:g.title })),question.groupId)}</select></label><div class="question-stage-nav" role="group" aria-label="Stufen">${[...new Set(groupQuestions.map(q => q.level).filter(Boolean))].sort().map(level => `<button class="stage-button${level === question.level ? ' active' : ''}" data-level="${level}" aria-pressed="${level === question.level}">Stufe ${level}</button>`).join('')}</div><ol class="question-list">${groupQuestions.map(q => `<li><button data-question="${esc(q.id)}" class="question-list-item${q.id === question.id ? ' active' : ''}" aria-current="${q.id === question.id ? 'step' : 'false'}"><span class="question-list-id">${esc(q.id)}</span><span>${q.level ? `Stufe ${q.level} · ` : ''}${esc(isOpen(q) || (q.kind==='initial_classification'?questionAnswerLabel(q,responseOf(q.id).answer):(responseOf(q.id).finding === 'fulfilled' ? 'Erfüllt' : 'Nicht vollständig erfüllt')))}</span></button></li>`).join('')}</ol><button class="btn btn-secondary" id="next-open-question">Nächste offene Frage →</button></aside>`}<div><div id="question-card-host"></div>${mode !== 'detail' ? explanationHtml(catalogs,payload,result,ui,question) : ''}</div></div>` : `<div class="card empty-state"><h2>${componentId === 'practices' && !practice ? 'Practices auswählen' : mode === 'detail' ? 'Direkte Einzelnoten' : 'Erforderliche Fragen bearbeitet'}</h2><p class="muted">${mode === 'detail' ? 'Die eigenen Stufenanker stehen unten zur Auswahl.' : 'Alle Antworten und freiwillige höhere Merkmale bleiben zugänglich.'}</p><button class="btn btn-secondary" data-mode="all">Alle Fragen öffnen</button></div>`}
    ${mode === 'detail' ? '<div id="rating-profile-host"></div>' : ''}`;

  container.querySelectorAll('[data-component]').forEach(button => button.onclick = () => navigate({ componentId:button.dataset.component,questionId:null,groupId:null,mode:'required' }));
  container.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => navigate({ mode:button.dataset.mode,questionId:null,groupId:null }));
  container.querySelector('#conversation-toggle').onclick = () => navigate({ conversation:!ui.conversation });
  const practiceSelect = container.querySelector('#assessment-practice');
  if (practiceSelect) practiceSelect.onchange = () => navigate({ practiceId:practiceSelect.value,questionId:null,groupId:null });
  container.querySelectorAll('[data-question]').forEach(button => button.onclick = () => {
    const target = catalogs.questionsById.get(button.dataset.question); const required = worklist.some(q => q.id === target?.id);
    navigate({ questionId:button.dataset.question,...(!required ? { mode:'all' } : {}) });
  });
  container.querySelectorAll('[data-level]').forEach(button => button.onclick = () => {
    const next = groupQuestions.find(q => q.level === Number(button.dataset.level) && isOpen(q)) || groupQuestions.find(q => q.level === Number(button.dataset.level));
    if (next) navigate({ questionId:next.id });
  });
  const groupSelect = container.querySelector('#assessment-group');
  if (groupSelect) groupSelect.onchange = () => {
    const group = worklist.filter(q => q.groupId === groupSelect.value); const next = group.find(isOpen) || group[0];
    if (next) navigate({ questionId:next.id,groupId:next.groupId });
  };
  const nextOpen = container.querySelector('#next-open-question');
  if (nextOpen) nextOpen.onclick = () => {
    const index = worklist.findIndex(q => q.id === question.id); const candidates = [...worklist.slice(index + 1),...worklist.slice(0,index + 1)]; const next = candidates.find(isOpen);
    if (next) navigate({ questionId:next.id }); else navigate({ questionId:question.id,mode:'all' });
  };
  if (question) renderQuestionCard(container.querySelector('#question-card-host'),{ question,record,ui,worklist,navigate,change,onEvidence,onDefer });
  if (mode === 'detail') {
    const units = componentId === 'practices' ? practice?.module.rating_units || [] : component.catalog.rating_units || [];
    renderRatingProfile(container.querySelector('#rating-profile-host'),component.catalog,units,record,change,ui);
  }
}

function renderQuestionCard(host,{ question:q,record,ui,worklist,navigate,change,onEvidence,onDefer }) {
  const current = () => record.responses.find(row => row.question_id === q.id); const response = current(); const index = worklist.findIndex(row => row.id === q.id);
  const {introduction,prompt} = splitQuestionText(q);
  host.innerHTML = `<article class="card question-card"><div class="question-card-meta"><span class="badge">${q.kind === 'initial_classification' ? 'Anfangszustand einordnen' : q.categoryRequirement ? 'Kategorie-Voraussetzung' : q.evidenceHelper ? 'Optionale Nachweishilfe' : q.practiceId ? 'Einzelaspekt der Practice' : 'Optionaler Einzelaspekt'}</span><span class="muted">${ui.conversation ? '' : `${esc(q.id)} · `}${q.level ? `Stufe ${q.level}` : 'Anwendung'}</span></div><h2>${introduction ? `<span class="question-introduction">${esc(introduction)}</span>\n` : ''}<span class="question-prompt">${esc(prompt)}</span></h2>
    ${q.workflowOptional ? `<p class="muted small question-context">${esc(q.optionalReason)}</p>` : ''}${q.scope_instruction ? `<p class="muted">${esc(q.scope_instruction)}</p>` : ''}
    <div class="checkpoint-panel"><h3>${q.kind==='initial_classification'?'Diese Befunde bestimmen die Einordnung':'Diese Frage umfasst folgende Anforderungen'}</h3><ul class="checkpoint-list">${q.checks.map(check => `<li>${esc(check.text)}${check.applicability?.kind === 'scope_flag_true' ? '<span class="badge">Anwendbarkeit hängt vom Umfang ab</span>' : ''}</li>`).join('')}</ul></div>
    <label class="field simple-answer">Deine Antwort<select id="question-answer">${optionTags(q.answerOptions,questionAnswerIsSelected(response,ui) ? response.answer : null,'Bitte auswählen')}</select><small>${esc(questionAnswerHelp(q))}</small></label>
    <p class="simple-answer-status" role="status">${!questionAnswerIsSelected(response,ui) ? 'Noch keine Antwort gewählt.' : response.review_status === 'pending' ? 'Der Umfang hat sich geändert. Bitte die Antwort erneut wählen oder bewusst für den aktuellen Umfang übernehmen.' : questionAnswerStatus(q,response.answer)}</p>
    ${canResubmitAnswer(response,ui) ? '<div class="notice neutral"><p>Die bisherige Antwort ist erhalten, zählt nach der Umfangsänderung aber erst wieder nach deiner Bestätigung.</p><button type="button" class="btn btn-primary" id="resubmit-current-answer">Antwort für aktuellen Umfang übernehmen</button></div>' : ''}
    <details class="question-help"><summary>Fachlicher Hinweis & Beispiele</summary><p>${esc(q.help_text || q.assessor_focus || q.requirements_text || '')}</p>${q.evidenceHelp ? `<p>${esc(q.evidenceHelp)}</p>` : ''}${q.evidenceExamples.length ? `<ul>${q.evidenceExamples.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}${q.healthcare_example?.text ? `<p><strong>Beispiel:</strong> ${esc(q.healthcare_example.text)}</p>` : ''}<p class="muted">${esc(q.catalogId)} · Version ${esc(q.catalogVersion)}${q.moduleId ? ` · ${esc(q.moduleId)} · ${esc(q.moduleVersion)}` : ''}</p></details>
    <details class="optional-evidence"><summary>Optionale Notiz & Nachweise</summary><p class="muted small">Diese Angaben helfen beim späteren Nachvollziehen. Sie sind für die einfache Einstufung nicht erforderlich.</p><label class="field">Notiz (optional)<textarea id="question-rationale" rows="3" placeholder="Ein Beispiel, eine Beobachtung oder eine offene Frage …">${esc(response?.assessor_rationale)}</textarea></label><fieldset class="evidence-picker"><legend>Nachweise zuordnen (optional)</legend>${record.evidence_register.length ? record.evidence_register.map(item => `<label class="evidence-option"><input type="checkbox" data-evidence-id="${esc(item.evidence_id)}"${response?.evidence_ids.includes(item.evidence_id) ? ' checked' : ''}><span><strong>${esc(item.title)}</strong><small>${esc(item.evidence_type)}</small></span></label>`).join('') : '<p class="muted">Noch keine Nachweise erfasst.</p>'}<button class="btn btn-secondary" type="button" id="go-evidence">Nachweisregister öffnen ↗</button></fieldset></details>
    <div class="question-nav"><button class="btn btn-secondary" id="previous-question"${index <= 0 ? ' disabled' : ''}>← Vorherige Frage</button><button class="btn btn-secondary" id="defer-question">Später beantworten</button><span class="muted">Frage ${index + 1} von ${worklist.length}</span><button class="btn btn-primary" id="next-question"${index >= worklist.length - 1 ? ' disabled' : ''}>Nächste Frage →</button></div></article>`;
  host.querySelector('#question-answer').onchange = event => { submitSimpleAnswer(record,q.id,event.target.value,ui); change(event.target.value ? 'answer' : 'answer-cleared',q.id); };
  const resubmit = host.querySelector('#resubmit-current-answer');
  if (resubmit) resubmit.onclick = () => {
    if (!canResubmitAnswer(current(),ui)) return;
    resubmitSimpleAnswer(record,q.id,ui); change('answer',q.id);
  };
  const auxiliary = (changes,reason) => { if (!current()) markQuestionAnswerSelection(ui,q.id,false); updateResponse(record,q.id,changes); change(reason,q.id); };
  host.querySelector('#question-rationale').oninput = event => auxiliary({ assessor_rationale:event.target.value },'rationale');
  host.querySelectorAll('[data-evidence-id]').forEach(input => input.onchange = () => { const ids = [...host.querySelectorAll('[data-evidence-id]:checked')].map(input => input.dataset.evidenceId); auxiliary({ evidence_ids:ids },'evidence-link'); });
  host.querySelector('#go-evidence').onclick = () => onEvidence?.({ questionId:q.id,componentId:q.componentId });
  host.querySelector('#defer-question').onclick = () => {
    if (!current()) { markQuestionAnswerSelection(ui,q.id,false); updateResponse(record,q.id,{}); }
    onDefer?.({ componentId:q.componentId,questionId:q.id,title:q.text,reason:responseOpenReason(current(),record,ui) || 'Später nochmals ansehen',practiceId:q.practiceId }); change('deferred',q.id);
    const next = [...worklist.slice(index + 1),...worklist.slice(0,index)].find(question => responseOpenReason(record.responses.find(row => row.question_id === question.id),record,ui)); if (next) navigate({ questionId:next.id });
  };
  host.querySelector('#previous-question').onclick = () => navigate({ questionId:worklist[index - 1]?.id }); host.querySelector('#next-question').onclick = () => navigate({ questionId:worklist[index + 1]?.id });
}

function renderRatingProfile(host,catalog,units,record,change,ui) {
  if (!units.length) { host.innerHTML = ''; return; }
  const getRating = id => record.extensions.criterion_ratings.find(row => row.criterion_id === id);
  host.innerHTML = `<div class="card rating-profile"><h2>Optionale Einzelnoten</h2><p class="muted">Eine Einzelnote anhand der vollständigen Stufenanker wählen. Kategorie-Voraussetzungen werden separat bewertet; Notizen sind optional.</p>${units.map(unit => {
    const row = getRating(unit.criterion_id);
    return `<details class="rating-unit" data-rating="${esc(unit.criterion_id)}"><summary>${esc(unit.title)} <span class="badge">${row?.review_status === 'approved' ? `Einzelnote ${row.assessed_level ?? 'offen'}` : 'Noch offen'}</span></summary><p>${esc(unit.rating_question)}</p><ol class="rating-anchors">${unit.level_anchors.map(anchor => `<li value="${anchor.level}">${esc(anchor.description)}</li>`).join('')}</ol><label class="field">Deine Einzelnote<select data-rating-level>${optionTags([1,2,3,4,5].map(level => ({ id:String(level),label:`Stufe ${level}` })),row?.review_status === 'approved' && row.assessed_level != null ? String(row.assessed_level) : '','Bitte auswählen')}</select></label><details><summary>Optionale Notiz</summary><label class="field">Notiz<textarea data-rating-note rows="2">${esc(row?.assessor_rationale)}</textarea></label></details><div data-rating-error role="alert"></div></details>`;
  }).join('')}</div>`;
  host.querySelectorAll('[data-rating]').forEach(card => {
    const cid = card.dataset.rating;
    const ensure = () => { let row = getRating(cid); if (!row) { row = { criterion_id:cid,assessed_level:null,possible_upper_level:null,review_status:'pending',evidence_status:'not_checked',evidence_ids:[],assessor_rationale:'',reviewer_id:null,reviewed_at:null }; record.extensions.criterion_ratings.push(row); } return row; };
    card.querySelector('[data-rating-level]').onchange = event => {
      const existing = getRating(cid); const previous = existing ? structuredClone(existing) : null;
      const level = event.target.value ? Number(event.target.value) : null;
      if (level == null) { record.extensions.criterion_ratings = record.extensions.criterion_ratings.filter(row => row.criterion_id !== cid); card.querySelector('summary .badge').textContent = 'Noch offen'; change('criterion-rating-cleared',cid); return; }
      const row = ensure();
      row.assessed_level = level; row.possible_upper_level = level; row.review_status = level == null ? 'pending' : 'approved'; row.evidence_status = 'not_checked'; row.reviewer_id = null; row.reviewed_at = null; card.querySelector('[data-rating-error]').textContent = '';
      try { evaluate(catalog,record,null,{ mode:'simplified_self_assessment' }); }
      catch (error) { if (previous) Object.assign(row,previous); else record.extensions.criterion_ratings = record.extensions.criterion_ratings.filter(item => item !== row); card.querySelector('[data-rating-error]').innerHTML = `<p class="form-error">Die Einzelnote passt nicht zu den bisherigen Antworten: ${esc(error.message)}</p>`; change('criterion-rating-error',cid); return; }
      card.querySelector('summary .badge').textContent = level == null ? 'Noch offen' : `Einzelnote ${level}`; change(level == null ? 'criterion-rating' : 'criterion-rating-approved',cid);
    };
    card.querySelector('[data-rating-note]').oninput = event => { ensure().assessor_rationale = event.target.value; change('criterion-rating-note',cid); };
  });
}
