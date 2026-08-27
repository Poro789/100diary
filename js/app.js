/*
 * 100diary — 全部应用逻辑（无依赖，零网络请求）
 *
 * 数据存储：浏览器 localStorage，键名 diary.records.v1，仅存于本机。
 * 备份方式：页面内「导出 JSON」生成备份文件；「导入 JSON」从备份恢复（导入将替换当前数据）。
 *
 * 数据结构（与导出文件一致，面向未来 AI 分析导出设计，无需迁移）：
 * {
 *   "name": "用户名称（选填）；界面标题显示为「XX的日记」，未设置时显示「日记」",
 *   "entries": [
 *     {
 *       "id": "20260826-001",
 *       "date": "2026-08-26",
 *       "items": [
 *         { "event": "解决了一个底层技术问题", "mood": "喜悦", "body": "精力充沛" },
 *         { "event": "只记了事件，没选状态" },
 *         { "event": "旧版本记录", "reaction": "旧版自由文本（legacy，原样保留）" }
 *       ]
 *     }
 *   ]
 * }
 *
 * 字段说明：
 *   name      选填，用户名称（标题编辑处设置；显示为「XX的日记」）
 *   event     必填，客观描述
 *   mood      选填，MOOD_OPTIONS 之一；未选时省略该字段
 *   body      选填，BODY_OPTIONS 之一；未选时省略该字段
 *   reaction  旧版自由文本，仅存量数据会有，编辑时原样保留
 *
 * 派生说明：
 *   Day X（第几天）= 该日期在「有记录的日期」升序中的序号（不含未记录的日子，
 *   与"不强制每天写"的定位一致）。派生字段，不冗余存储，导入后自动一致。
 *   emoji 为 UI 层显示映射（MOOD_EMOJI / BODY_EMOJI），JSON 始终存文字标签。
 *
 * 选项依据（最广泛验证的科学理论）：
 *   mood：Plutchik 情绪轮 8 种基本情绪（临床实践与情感计算中使用最广的离散情绪模型）
 *         + 「平静」中性锚点（Russell 环状模型中心区，低唤醒）
 *         映射：喜悦=Joy 安心=Trust 期待=Anticipation 惊讶=Surprise
 *               悲伤=Sadness 厌恶=Disgust 愤怒=Anger 恐惧=Fear
 *   body：基于唤醒维度（arousal，环状模型核心维度）与躯体标记研究中最常见的验证状态
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'diary.records.v1';
  var MOOD_OPTIONS = ['平静', '喜悦', '安心', '期待', '惊讶', '悲伤', '厌恶', '愤怒', '恐惧'];
  var BODY_OPTIONS = ['放松', '精力充沛', '紧绷', '疲惫', '麻木'];
  var MOOD_EMOJI = {
    '平静': '😌', '喜悦': '😄', '安心': '🤗', '期待': '👀',
    '惊讶': '😲', '悲伤': '😢', '厌恶': '🤢', '愤怒': '😠', '恐惧': '😨'
  };
  var BODY_EMOJI = {
    '放松': '🧘', '精力充沛': '⚡', '紧绷': '😖', '疲惫': '😪', '麻木': '🧊'
  };

  var data = { name: '', entries: [] };
  var expanded = new Set();
  var editing = null; // { dayId, index }
  var draft = null; // { event, mood, body } 编辑草稿
  var formRows = [{ event: '', mood: '', body: '' }];
  var toastTimer = null;
  var lastImageName = '';

  var elForm = document.getElementById('entry-form');
  var elDate = document.getElementById('f-date');
  var elFormRows = document.getElementById('form-rows');
  var elList = document.getElementById('list');
  var elToast = document.getElementById('toast');
  var elTitle = document.getElementById('app-title');
  var elTitleEdit = document.getElementById('btn-title-edit');
  var elDayNum = document.getElementById('form-daynum');
  var elSheet = document.getElementById('sheet');
  var elSheetBackdrop = document.getElementById('sheet-backdrop');
  var elSheetTitle = document.getElementById('sheet-title');
  var elSheetOptions = document.getElementById('sheet-options');
  var elImgBackdrop = document.getElementById('img-backdrop');
  var elImg = document.getElementById('img-preview');
  var elImgHint = document.getElementById('img-hint');

  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function validDateStr(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00'));
  }

  function emojiOf(kind, value) {
    var map = kind === 'mood' ? MOOD_EMOJI : BODY_EMOJI;
    return map[value] || '';
  }

  // Day X：该日期在「有记录的日期」升序中的序号（未记录的日子不计入）
  function dayNum(dateStr) {
    var set = {};
    data.entries.forEach(function (e) { set[e.date] = true; });
    var dates = Object.keys(set).sort();
    var n = 1;
    for (var i = 0; i < dates.length; i++) {
      if (dates[i] < dateStr) n++;
    }
    return n;
  }

  // 生成形如 20260826-001 的唯一 id（date + 当日序号）
  function nextId(dateStr, pool) {
    pool = pool || data.entries;
    var ymd = dateStr.replace(/-/g, '');
    var re = new RegExp('^' + ymd + '-(\\d+)$');
    var max = 0;
    pool.forEach(function (e) {
      var m = re.exec(String(e.id || ''));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    var id;
    do {
      max += 1;
      id = ymd + '-' + String(max).padStart(3, '0');
    } while (pool.some(function (e) { return e.id === id; }));
    return id;
  }

  function countItems(entries) {
    return entries.reduce(function (n, e) { return n + e.items.length; }, 0);
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.entries)) return;
      data = {
        name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
        entries: parsed.entries
          .filter(function (e) { return e && validDateStr(e.date) && Array.isArray(e.items); })
          .map(function (e) {
            return {
              id: (typeof e.id === 'string' && e.id) ? e.id : nextId(e.date),
              date: e.date,
              items: normalizeItems(e.items)
            };
          })
      };
    } catch (err) {
      // 数据损坏时保留空状态，避免应用不可用
      data = { name: '', entries: [] };
    }
  }

  // 归一化单条事件：event 必填；mood/body 选填字符串；reaction 为旧版自由文本（保留）
  function normalizeItems(items) {
    return items
      .filter(function (it) { return it && typeof it.event === 'string' && it.event.trim(); })
      .map(function (it) {
        return {
          event: it.event,
          mood: typeof it.mood === 'string' ? it.mood : '',
          body: typeof it.body === 'string' ? it.body : '',
          reaction: typeof it.reaction === 'string' ? it.reaction : ''
        };
      });
  }

  // 组装导出/存储用的 item：未选的 mood/body 省略
  function buildItem(event, mood, body, reaction) {
    var item = { event: event };
    if (mood) item.mood = mood;
    if (body) item.body = body;
    if (reaction) item.reaction = reaction;
    return item;
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function toast(msg) {
    elToast.textContent = msg;
    elToast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { elToast.style.display = 'none'; }, 1800);
  }

  function findDay(dayId) {
    for (var i = 0; i < data.entries.length; i++) {
      if (data.entries[i].id === dayId) return data.entries[i];
    }
    return null;
  }

  function sortedDays() {
    return data.entries.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
  }

  function button(label, onClick, extraClass) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (extraClass ? ' ' + extraClass : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // 事件输入：多行自动增高（超出上限后内部滚动）
  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  // ---------- 日记名称（与大标题结合：标题 = 「用户名称」+ 的日记） ----------
  function renderTitle() {
    elTitle.textContent = data.name ? data.name + '的日记' : '日记';
  }

  function startTitleEdit() {
    if (document.getElementById('title-input')) return;
    var head = elTitle.parentNode;
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'title-input';
    input.className = 'inp title-input';
    input.value = data.name;
    input.placeholder = '你的名字';
    input.maxLength = 20;
    input.autocomplete = 'off';
    head.insertBefore(input, elTitle);
    elTitle.hidden = true;
    elTitleEdit.hidden = true;
    input.focus();
    input.select();
    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      if (save) {
        var v = input.value.trim();
        data.name = v; // 空则恢复默认「日记」
        persist();
      }
      head.removeChild(input);
      elTitle.hidden = false;
      elTitleEdit.hidden = false;
      renderTitle();
    }
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', function () { finish(true); });
  }

  elTitleEdit.addEventListener('click', startTitleEdit);
  elTitle.addEventListener('click', startTitleEdit);

  // ---------- 底部弹框选择（移动端友好：底部上滑面板 + 大触控目标） ----------
  function chip(label, selected) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (selected ? ' selected' : '');
    b.textContent = label;
    return b;
  }

  // 交互：点选项 = 选中；点已选中的选项 = 取消；
  // 选择后弹框保持打开，可停留、反复修改，完成后手动关闭
  function openSheet(kind, options, current, onPick) {
    elSheetTitle.textContent = kind === 'mood' ? '选择情绪' : '选择身体';
    elSheetOptions.textContent = '';
    var selected = current;
    options.forEach(function (opt) {
      var em = emojiOf(kind, opt);
      var c = chip(em ? em + ' ' + opt : opt, opt === selected);
      c.addEventListener('click', function () {
        selected = (opt === selected) ? '' : opt;
        Array.prototype.forEach.call(elSheetOptions.children, function (ch) {
          ch.classList.remove('selected');
        });
        if (selected) c.classList.add('selected');
        onPick(selected);
      });
      elSheetOptions.appendChild(c);
    });
    elSheetBackdrop.hidden = false;
    elSheet.hidden = false;
  }

  function closeSheet() {
    elSheetBackdrop.hidden = true;
    elSheet.hidden = true;
  }

  elSheetBackdrop.addEventListener('click', closeSheet);
  document.getElementById('btn-sheet-close').addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      closeSheet();
      closeDateDialog();
      elImgBackdrop.hidden = true;
    }
  });

  // 表单/编辑共用的选择按钮
  function pickBtn(label, kind, options, value, onPick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn pick' + (value ? ' picked' : '');
    b.textContent = value ? label + '：' + emojiOf(kind, value) + ' ' + value : label + '（可选）';
    b.addEventListener('click', function () {
      openSheet(kind, options, value, onPick);
    });
    return b;
  }

  // ---------- 多事件表单 ----------
  function renderFormRows() {
    elFormRows.textContent = '';
    formRows.forEach(function (row, i) {
      var div = document.createElement('div');
      div.className = 'frow';
      var inp = document.createElement('textarea');
      inp.className = 'inp ev-inp';
      inp.rows = 1;
      inp.placeholder = '发生了什么';
      inp.value = row.event;
      inp.addEventListener('input', function () {
        row.event = inp.value;
        autosize(inp);
      });
      // Enter 换行；Ctrl/⌘+Enter 提交
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) elForm.requestSubmit();
      });
      autosize(inp);
      var picks = document.createElement('div');
      picks.className = 'pickers';
      picks.appendChild(pickBtn('情绪', 'mood', MOOD_OPTIONS, row.mood, function (v) {
        row.mood = v;
        renderFormRows();
      }));
      picks.appendChild(pickBtn('身体', 'body', BODY_OPTIONS, row.body, function (v) {
        row.body = v;
        renderFormRows();
      }));
      // 任意一行（含第一条）都可移除；删完最后一行时补一条空白行
      picks.appendChild(button('移除', function () {
        if (!confirm('删除这条事件？未保存的内容将丢失。')) return;
        formRows.splice(i, 1);
        if (!formRows.length) formRows.push({ event: '', mood: '', body: '' });
        renderFormRows();
      }, 'row-del'));
      div.appendChild(inp);
      div.appendChild(picks);
      elFormRows.appendChild(div);
    });
  }

  document.getElementById('btn-add-row').addEventListener('click', function () {
    formRows.push({ event: '', mood: '', body: '' });
    renderFormRows();
  });

  function updateFormDayNum() {
    var d = elDate.value;
    elDayNum.textContent = validDateStr(d) ? 'Day ' + dayNum(d) : '';
  }

  elDate.addEventListener('change', updateFormDayNum);

  elForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var date = elDate.value;
    if (!validDateStr(date)) { toast('请选择日期'); return; }
    var valid = formRows.filter(function (r) { return r.event.trim(); });
    if (!valid.length) { toast('至少填写一条事件'); return; }

    var day = null;
    for (var i = 0; i < data.entries.length; i++) {
      if (data.entries[i].date === date) { day = data.entries[i]; break; }
    }
    if (!day) {
      day = { id: nextId(date), date: date, items: [] };
      data.entries.push(day);
    }
    valid.forEach(function (r) {
      day.items.push(buildItem(r.event.trim(), r.mood, r.body));
    });
    formRows = [{ event: '', mood: '', body: '' }];
    renderFormRows();
    expanded.add(day.id);
    persist();
    render();
    toast('已保存 ' + valid.length + ' 条');
  });

  // ---------- 历史列表 ----------
  function deleteItem(day, index) {
    if (!confirm('删除这条事件记录？')) return;
    day.items.splice(index, 1);
    if (day.items.length === 0) {
      data.entries = data.entries.filter(function (e) { return e.id !== day.id; });
      expanded.delete(day.id);
    }
    editing = null;
    draft = null;
    persist();
    render();
  }

  function deleteDay(dayId) {
    var day = findDay(dayId);
    if (!day) return;
    if (!confirm('删除 ' + day.date + ' 的全部 ' + day.items.length + ' 条记录？')) return;
    data.entries = data.entries.filter(function (e) { return e.id !== dayId; });
    expanded.delete(dayId);
    editing = null;
    draft = null;
    persist();
    render();
  }

  // ---------- 改日期：专用弹框（原生 date 控件，移动端自动弹系统日期选择器） ----------
  var elDateDialog = document.getElementById('date-dialog');
  var elDateDialogBackdrop = document.getElementById('date-backdrop');
  var elDateDialogInput = document.getElementById('date-dialog-input');
  var dateDialogDayId = null;

  function openDateDialog(dayId) {
    var day = findDay(dayId);
    if (!day) return;
    dateDialogDayId = dayId;
    elDateDialogInput.value = day.date;
    elDateDialogBackdrop.hidden = false;
    elDateDialog.hidden = false;
    elDateDialogInput.focus();
  }

  function closeDateDialog() {
    dateDialogDayId = null;
    elDateDialogBackdrop.hidden = true;
    elDateDialog.hidden = true;
  }

  function changeDayDate(dayId, newDate) {
    var day = findDay(dayId);
    if (!day) return;
    var v = newDate.trim();
    if (!validDateStr(v)) { toast('日期格式无效'); return; }
    var other = null;
    for (var i = 0; i < data.entries.length; i++) {
      if (data.entries[i].id !== dayId && data.entries[i].date === v) { other = data.entries[i]; break; }
    }
    if (other) {
      // 目标日期已有记录：合并，保持一天一条日记录
      other.items = other.items.concat(day.items);
      data.entries = data.entries.filter(function (e) { return e.id !== dayId; });
      expanded.delete(dayId);
      expanded.add(other.id);
    } else {
      day.date = v;
      day.id = nextId(v);
    }
    editing = null;
    draft = null;
    persist();
    render();
  }

  elDateDialogBackdrop.addEventListener('click', closeDateDialog);
  document.getElementById('btn-date-cancel').addEventListener('click', closeDateDialog);
  document.getElementById('btn-date-ok').addEventListener('click', function () {
    var dayId = dateDialogDayId;
    var v = elDateDialogInput.value;
    closeDateDialog();
    if (dayId) changeDayDate(dayId, v);
  });

  function itemMeta(item) {
    var meta = [];
    if (item.mood) meta.push('情绪 · ' + emojiOf('mood', item.mood) + ' ' + item.mood);
    if (item.body) meta.push('身体 · ' + emojiOf('body', item.body) + ' ' + item.body);
    if (item.reaction) meta.push('状态 · ' + item.reaction);
    return meta.join('    ');
  }

  function renderBody(day) {
    var body = document.createElement('div');
    body.className = 'day-body';
    day.items.forEach(function (item, index) {
      var row = document.createElement('div');
      row.className = 'item';
      if (editing && editing.dayId === day.id && editing.index === index) {
        var evIn = document.createElement('textarea');
        evIn.className = 'inp ev-inp';
        evIn.rows = 1;
        evIn.value = draft.event;
        evIn.addEventListener('input', function () {
          draft.event = evIn.value;
          autosize(evIn);
        });
        autosize(evIn);
        var picks = document.createElement('div');
        picks.className = 'pickers';
        picks.appendChild(pickBtn('情绪', 'mood', MOOD_OPTIONS, draft.mood, function (v) {
          draft.mood = v;
          render();
        }));
        picks.appendChild(pickBtn('身体', 'body', BODY_OPTIONS, draft.body, function (v) {
          draft.body = v;
          render();
        }));
        var main = document.createElement('div');
        main.className = 'item-main';
        main.appendChild(evIn);
        main.appendChild(picks);
        if (item.reaction) {
          var note = document.createElement('p');
          note.className = 'item-reaction';
          note.textContent = '旧版自由文本将保留：' + item.reaction;
          main.appendChild(note);
        }
        var ok = button('保存', function () {
          var v = draft.event.trim();
          if (!v) { toast('事件不能为空'); return; }
          day.items[index] = buildItem(v, draft.mood, draft.body, item.reaction);
          editing = null;
          draft = null;
          persist();
          render();
        });
        var cancel = button('取消', function () {
          editing = null;
          draft = null;
          render();
        });
        var act = document.createElement('span');
        act.className = 'item-actions';
        act.appendChild(ok);
        act.appendChild(cancel);
        row.appendChild(main);
        row.appendChild(act);
        evIn.focus();
      } else {
        var main2 = document.createElement('div');
        main2.className = 'item-main';
        var ev = document.createElement('p');
        ev.className = 'item-event';
        ev.textContent = item.event;
        main2.appendChild(ev);
        var meta = itemMeta(item);
        if (meta) {
          var rc = document.createElement('p');
          rc.className = 'item-reaction';
          rc.textContent = meta;
          main2.appendChild(rc);
        }
        var act2 = document.createElement('span');
        act2.className = 'item-actions';
        act2.appendChild(button('编辑', function () {
          editing = { dayId: day.id, index: index };
          draft = { event: item.event, mood: item.mood || '', body: item.body || '' };
          render();
        }));
        act2.appendChild(button('删除', function () { deleteItem(day, index); }, 'danger'));
        row.appendChild(main2);
        row.appendChild(act2);
      }
      body.appendChild(row);
    });
    return body;
  }

  function render() {
    elList.textContent = '';
    var days = sortedDays();
    if (!days.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '暂无记录';
      elList.appendChild(empty);
      return;
    }
    days.forEach(function (day) {
      var open = expanded.has(day.id);
      var li = document.createElement('li');
      li.className = 'day';

      var head = document.createElement('div');
      head.className = 'day-head';

      var toggle = button(open ? '−' : '+', function () {
        if (open) expanded.delete(day.id); else expanded.add(day.id);
        render();
      }, 'toggle');
      toggle.title = open ? '折叠' : '展开';

      var dateLabel = document.createElement('span');
      dateLabel.className = 'day-date';
      dateLabel.textContent = day.date;

      var dayNumEl = document.createElement('span');
      dayNumEl.className = 'day-num';
      dayNumEl.textContent = 'Day ' + dayNum(day.date);

      var count = document.createElement('span');
      count.className = 'day-count';
      count.textContent = day.items.length + ' 条';

      var actions = document.createElement('span');
      actions.className = 'day-actions';
      actions.appendChild(button('导出图片', function () { renderDayImage(day); }));
      actions.appendChild(button('改日期', function () { openDateDialog(day.id); }));
      actions.appendChild(button('删除当天', function () { deleteDay(day.id); }, 'danger'));

      head.appendChild(toggle);
      head.appendChild(dateLabel);
      head.appendChild(dayNumEl);
      head.appendChild(count);
      head.appendChild(actions);
      li.appendChild(head);

      if (open) li.appendChild(renderBody(day));
      elList.appendChild(li);
    });
  }

  // ---------- 保存为图片（极简风，移动端竖版长图，仅单日） ----------
  var IMG_FONT = '"PingFang SC","Microsoft YaHei","Noto Sans SC","Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

  function weekday(dateStr) {
    var names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return names[new Date(dateStr + 'T00:00:00').getDay()];
  }

  // 按字符逐字换行（中文场景）
  function wrapText(ctx, text, maxWidth) {
    var lines = [];
    String(text).split('\n').forEach(function (part) {
      var line = '';
      for (var i = 0; i < part.length; i++) {
        var ch = part[i];
        if (line && ctx.measureText(line + ch).width > maxWidth) {
          lines.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
      lines.push(line);
    });
    if (!lines.length) lines.push('');
    return lines;
  }

  function renderDayImage(day) {
    var W = 750, padX = 56, padTop = 64, padBottom = 60;
    var contentW = W - padX * 2;
    var meas = document.createElement('canvas').getContext('2d');

    var name = data.name ? data.name + '的日记' : '';
    var headLine = 'Day ' + dayNum(day.date) + ' · ' + day.date + ' · ' + weekday(day.date);

    var nameLines = [];
    var by; // 第一条内容的 y
    if (name) {
      meas.font = '600 30px ' + IMG_FONT;
      nameLines = wrapText(meas, name, contentW);
      by = padTop + nameLines.length * 42 + 14 + 32 + 26 + 40;
    } else {
      by = padTop + 44 + 28 + 40;
    }

    var blocks = day.items.map(function (item) {
      meas.font = '28px ' + IMG_FONT;
      var lines = wrapText(meas, item.event, contentW);
      var block = { lines: lines };
      var h = lines.length * 44;
      var meta = itemMeta(item);
      if (meta) {
        meas.font = '22px ' + IMG_FONT;
        block.metaLines = wrapText(meas, meta, contentW);
        h += 12 + block.metaLines.length * 32;
      }
      block.h = h;
      return block;
    });

    var H = by + blocks.reduce(function (n, b) { return n + b.h + 32; }, 0) + 40 + padBottom;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'top';

    var dividerY;
    if (name) {
      // 第一行：名称
      ctx.fillStyle = '#222';
      ctx.font = '600 30px ' + IMG_FONT;
      nameLines.forEach(function (line, i) {
        ctx.fillText(line, padX, padTop + i * 42);
      });
      // 第二行：Day X · 日期 · 星期
      var y2 = padTop + nameLines.length * 42 + 14;
      ctx.fillStyle = '#999';
      ctx.font = '24px ' + IMG_FONT;
      ctx.fillText(headLine, padX, y2);
      dividerY = y2 + 32 + 26;
    } else {
      // 单行头部：Day X · 日期 · 星期
      ctx.fillStyle = '#222';
      ctx.font = '600 34px ' + IMG_FONT;
      ctx.fillText(headLine, padX, padTop);
      dividerY = padTop + 44 + 28;
    }

    // 分隔线
    ctx.strokeStyle = '#e6e6e6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padX, dividerY);
    ctx.lineTo(W - padX, dividerY);
    ctx.stroke();

    // 事件条目
    blocks.forEach(function (b) {
      ctx.fillStyle = '#222';
      ctx.font = '28px ' + IMG_FONT;
      b.lines.forEach(function (line, i) {
        ctx.fillText(line, padX, by + i * 44);
      });
      by += b.lines.length * 44;
      if (b.metaLines) {
        by += 12;
        ctx.fillStyle = '#999';
        ctx.font = '22px ' + IMG_FONT;
        b.metaLines.forEach(function (line, i) {
          ctx.fillText(line, padX, by + i * 32);
        });
        by += b.metaLines.length * 32;
      }
      by += 32;
    });

    // 页脚
    ctx.fillStyle = '#bbb';
    ctx.font = '20px ' + IMG_FONT;
    ctx.fillText('100diary', padX, H - padBottom);

    showImage(canvas.toDataURL('image/png'), 'diary-' + day.date + '.png');
  }

  function isIOS() {
    return /iP(hone|od|ad)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function downloadImage() {
    var a = document.createElement('a');
    a.href = elImg.src;
    a.download = lastImageName || 'diary.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function showImage(dataUrl, filename) {
    elImg.src = dataUrl;
    lastImageName = filename;
    elImgHint.textContent = isIOS()
      ? '长按图片，选择「存储图像」即可保存到相册'
      : '已自动下载；也可点击「下载图片」或右键图片保存';
    elImgBackdrop.hidden = false;
    if (!isIOS()) downloadImage();
  }

  elImgBackdrop.addEventListener('click', function (ev) {
    if (ev.target === elImgBackdrop) elImgBackdrop.hidden = true;
  });
  document.getElementById('btn-img-close').addEventListener('click', function () {
    elImgBackdrop.hidden = true;
  });
  document.getElementById('btn-img-download').addEventListener('click', downloadImage);

  // ---------- 导出 ----------
  document.getElementById('btn-export').addEventListener('click', function () {
    if (!data.entries.length) { toast('暂无数据可导出'); return; }
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'diary-backup-' + todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('已导出');
  });

  // ---------- 导入 ----------
  document.getElementById('btn-import').addEventListener('click', function () {
    document.getElementById('file-import').click();
  });

  document.getElementById('file-import').addEventListener('change', function (ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(String(reader.result));
        if (!parsed || !Array.isArray(parsed.entries)) throw new Error('结构错误');
        var name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
        var entries = [];
        for (var i = 0; i < parsed.entries.length; i++) {
          var e = parsed.entries[i];
          if (!e || !validDateStr(e.date) || !Array.isArray(e.items)) continue;
          var items = normalizeItems(e.items);
          if (items.length) {
            var id = (typeof e.id === 'string' && e.id &&
              !entries.some(function (x) { return x.id === e.id; }))
              ? e.id : nextId(e.date, entries);
            entries.push({ id: id, date: e.date, items: items });
          }
        }
        if (!entries.length) { toast('文件中没有有效记录'); return; }
        if (data.entries.length) {
          var msg = '导入将替换当前 ' + data.entries.length + ' 天、共 ' +
            countItems(data.entries) + ' 条记录。继续？';
          if (!confirm(msg)) return;
        }
        data = { name: name, entries: entries };
        expanded.clear();
        editing = null;
        draft = null;
        persist();
        renderTitle();
        render();
        toast('导入完成：' + entries.length + ' 天');
      } catch (err) {
        toast('导入失败：文件格式不正确');
      }
    };
    reader.readAsText(file, 'utf-8');
  });

  // ---------- 初始化 ----------
  elDate.value = todayStr();
  load();
  renderTitle();
  updateFormDayNum();
  renderFormRows();
  render();
})();
