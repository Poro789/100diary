/*
 * 100diary — 全部应用逻辑（无依赖，零网络请求）
 *
 * 数据存储：浏览器 localStorage，键名 diary.records.v1，仅存于本机。
 * 备份方式：页面内「导出 JSON」生成备份文件；「导入 JSON」从备份恢复（导入将替换当前数据）。
 *
 * 数据结构（与导出文件一致，面向未来 AI 分析导出设计，无需迁移）：
 * {
 *   "entries": [
 *     {
 *       "id": "20260826-001",
 *       "date": "2026-08-26",
 *       "items": [
 *         { "event": "事件，客观描述发生了什么", "reaction": "可选的状态/反应描述" }
 *       ]
 *     }
 *   ]
 * }
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'diary.records.v1';
  var data = { entries: [] };
  var expanded = new Set();
  var editing = null; // { dayId, index }
  var toastTimer = null;

  var elForm = document.getElementById('entry-form');
  var elDate = document.getElementById('f-date');
  var elEvent = document.getElementById('f-event');
  var elReaction = document.getElementById('f-reaction');
  var elList = document.getElementById('list');
  var elToast = document.getElementById('toast');

  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function validDateStr(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00'));
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
        entries: parsed.entries
          .filter(function (e) { return e && validDateStr(e.date) && Array.isArray(e.items); })
          .map(function (e) {
            return {
              id: (typeof e.id === 'string' && e.id) ? e.id : nextId(e.date),
              date: e.date,
              items: e.items
                .filter(function (it) { return it && typeof it.event === 'string' && it.event.trim(); })
                .map(function (it) {
                  return { event: it.event, reaction: typeof it.reaction === 'string' ? it.reaction : '' };
                })
            };
          })
      };
    } catch (err) {
      // 数据损坏时保留空状态，避免应用不可用
      data = { entries: [] };
    }
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

  function deleteItem(day, index) {
    if (!confirm('删除这条事件记录？')) return;
    day.items.splice(index, 1);
    if (day.items.length === 0) {
      data.entries = data.entries.filter(function (e) { return e.id !== day.id; });
      expanded.delete(day.id);
    }
    editing = null;
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
    persist();
    render();
  }

  function editDate(dayId) {
    var day = findDay(dayId);
    if (!day) return;
    var v = prompt('修改日期（格式 YYYY-MM-DD）：', day.date);
    if (v === null) return;
    v = v.trim();
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
    persist();
    render();
  }

  function renderBody(day) {
    var body = document.createElement('div');
    body.className = 'day-body';
    day.items.forEach(function (item, index) {
      var row = document.createElement('div');
      row.className = 'item';
      if (editing && editing.dayId === day.id && editing.index === index) {
        var evIn = document.createElement('input');
        evIn.type = 'text';
        evIn.className = 'inp';
        evIn.value = item.event;
        var rcIn = document.createElement('textarea');
        rcIn.className = 'inp';
        rcIn.rows = 2;
        rcIn.value = item.reaction || '';
        var ok = button('保存', function () {
          var v = evIn.value.trim();
          if (!v) { toast('事件不能为空'); return; }
          day.items[index] = { event: v, reaction: rcIn.value.trim() };
          editing = null;
          persist();
          render();
        });
        var cancel = button('取消', function () { editing = null; render(); });
        row.appendChild(evIn);
        row.appendChild(rcIn);
        row.appendChild(ok);
        row.appendChild(cancel);
        evIn.focus();
      } else {
        var main = document.createElement('div');
        var ev = document.createElement('p');
        ev.className = 'item-event';
        ev.textContent = item.event;
        main.appendChild(ev);
        if (item.reaction) {
          var rc = document.createElement('p');
          rc.className = 'item-reaction';
          rc.textContent = item.reaction;
          main.appendChild(rc);
        }
        var act = document.createElement('span');
        act.className = 'item-actions';
        act.appendChild(button('编辑', function () {
          editing = { dayId: day.id, index: index };
          render();
        }));
        act.appendChild(button('删除', function () { deleteItem(day, index); }, 'danger'));
        row.appendChild(main);
        row.appendChild(act);
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

      var count = document.createElement('span');
      count.className = 'day-count';
      count.textContent = day.items.length + ' 条';

      var actions = document.createElement('span');
      actions.className = 'day-actions';
      actions.appendChild(button('改日期', function () { editDate(day.id); }));
      actions.appendChild(button('删除当天', function () { deleteDay(day.id); }, 'danger'));

      head.appendChild(toggle);
      head.appendChild(dateLabel);
      head.appendChild(count);
      head.appendChild(actions);
      li.appendChild(head);

      if (open) li.appendChild(renderBody(day));
      elList.appendChild(li);
    });
  }

  // ---------- 新增 ----------
  elForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var date = elDate.value;
    var eventText = elEvent.value.trim();
    if (!validDateStr(date)) { toast('请选择日期'); return; }
    if (!eventText) { toast('事件不能为空'); elEvent.focus(); return; }
    var reaction = elReaction.value.trim();

    var day = null;
    for (var i = 0; i < data.entries.length; i++) {
      if (data.entries[i].date === date) { day = data.entries[i]; break; }
    }
    if (!day) {
      day = { id: nextId(date), date: date, items: [] };
      data.entries.push(day);
    }
    day.items.push({ event: eventText, reaction: reaction });
    elEvent.value = '';
    elReaction.value = '';
    expanded.add(day.id);
    persist();
    render();
    toast('已保存');
  });

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
        var entries = [];
        for (var i = 0; i < parsed.entries.length; i++) {
          var e = parsed.entries[i];
          if (!e || !validDateStr(e.date) || !Array.isArray(e.items)) continue;
          var items = [];
          for (var j = 0; j < e.items.length; j++) {
            var it = e.items[j];
            if (it && typeof it.event === 'string' && it.event.trim()) {
              items.push({ event: it.event, reaction: typeof it.reaction === 'string' ? it.reaction : '' });
            }
          }
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
        data = { entries: entries };
        expanded.clear();
        editing = null;
        persist();
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
  render();
})();
