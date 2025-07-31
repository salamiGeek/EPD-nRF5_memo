let bleDevice, gattServer;
let epdService, epdCharacteristic;
let startTime, msgIndex, appVersion;
let canvas, ctx, textDecoder;

const EpdCmd = {
  SET_PINS:  0x00,
  INIT:      0x01,
  CLEAR:     0x02,
  SEND_CMD:  0x03,
  SEND_DATA: 0x04,
  REFRESH:   0x05,
  SLEEP:     0x06,

  SET_TIME:  0x20,
  // 移除了SET_MEMO命令，改为使用画布渲染

  WRITE_IMG: 0x30, // v1.6

  SET_CONFIG: 0x90,
  SYS_RESET:  0x91,
  SYS_SLEEP:  0x92,
  CFG_ERASE:  0x99,
};

const canvasSizes = [
  { name: '1.54_152_152', width: 152, height: 152 },
  { name: '1.54_200_200', width: 200, height: 200 },
  { name: '2.13_212_104', width: 212, height: 104 },
  { name: '2.13_250_122', width: 250, height: 122 },
  { name: '2.66_296_152', width: 296, height: 152 },
  { name: '2.9_296_128', width: 296, height: 128 },
  { name: '2.9_384_168', width: 384, height: 168 },
  { name: '3.5_384_184', width: 384, height: 184 },
  { name: '3.7_416_240', width: 416, height: 240 },
  { name: '3.97_800_480', width: 800, height: 480 },
  { name: '4.2_400_300', width: 400, height: 300 },
  { name: '5.79_792_272', width: 792, height: 272 },
  { name: '7.5_800_480', width: 800, height: 480 },
  { name: '10.2_960_640', width: 960, height: 640 },
  { name: '10.85_1360_480', width: 1360, height: 480 },
  { name: '11.6_960_640', width: 960, height: 640 },
  { name: '4E_600_400', width: 600, height: 400 },
  { name: '7.3E6', width: 480, height: 800 }
];

function hex2bytes(hex) {
  for (var bytes = [], c = 0; c < hex.length; c += 2)
    bytes.push(parseInt(hex.substr(c, 2), 16));
  return new Uint8Array(bytes);
}

function bytes2hex(data) {
  return new Uint8Array(data).reduce(
    function (memo, i) {
      return memo + ("0" + i.toString(16)).slice(-2);
    }, "");
}

function intToHex(intIn) {
  let stringOut = ("0000" + intIn.toString(16)).substr(-4)
  return stringOut.substring(2, 4) + stringOut.substring(0, 2);
}

function resetVariables() {
  gattServer = null;
  epdService = null;
  epdCharacteristic = null;
  msgIndex = 0;
  document.getElementById("log").value = '';
}

async function write(cmd, data, withResponse = true) {
  if (!epdCharacteristic) {
    addLog("服务不可用，请检查蓝牙连接");
    return false;
  }
  let payload = [cmd];
  if (data) {
    if (typeof data == 'string') data = hex2bytes(data);
    if (data instanceof Uint8Array) data = Array.from(data);
    payload.push(...data)
  }
  addLog(bytes2hex(payload), '⇑');
  try {
    if (withResponse)
      await epdCharacteristic.writeValueWithResponse(Uint8Array.from(payload));
    else
      await epdCharacteristic.writeValueWithoutResponse(Uint8Array.from(payload));
  } catch (e) {
    console.error(e);
    if (e.message) addLog("write: " + e.message);
    return false;
  }
  return true;
}

async function writeImage(data, step = 'bw') {
  const chunkSize = document.getElementById('mtusize').value - 2;
  const interleavedCount = document.getElementById('interleavedcount').value;
  const count = Math.round(data.length / chunkSize);
  let chunkIdx = 0;
  let noReplyCount = interleavedCount;

  for (let i = 0; i < data.length; i += chunkSize) {
    let currentTime = (new Date().getTime() - startTime) / 1000.0;
    setStatus(`${step == 'bw' ? '黑白' : '颜色'}块: ${chunkIdx + 1}/${count + 1}, 总用时: ${currentTime}s`);
    const payload = [
      (step == 'bw' ? 0x0F : 0x00) | (i == 0 ? 0x00 : 0xF0),
      ...data.slice(i, i + chunkSize),
    ];
    if (noReplyCount > 0) {
      await write(EpdCmd.WRITE_IMG, payload, false);
      noReplyCount--;
    } else {
      await write(EpdCmd.WRITE_IMG, payload, true);
      noReplyCount = interleavedCount;
    }
    chunkIdx++;
  }
}

async function setDriver() {
  await write(EpdCmd.SET_PINS, document.getElementById("epdpins").value);
  await write(EpdCmd.INIT, document.getElementById("epddriver").value);
}

async function syncTime(mode) {
  if (mode === 2) {
    if (!confirm('提醒：时钟模式目前使用全刷实现，仅供体验，不建议长期开启，是否继续?')) return;
  }
  const timestamp = new Date().getTime() / 1000;
  const data = new Uint8Array([
    (timestamp >> 24) & 0xFF,
    (timestamp >> 16) & 0xFF,
    (timestamp >> 8) & 0xFF,
    timestamp & 0xFF,
    -(new Date().getTimezoneOffset() / 60),
    mode
  ]);
  if (await write(EpdCmd.SET_TIME, data)) {
    addLog("时间已同步！");
    addLog("屏幕刷新完成前请不要操作。");
  }
}

async function clearScreen() {
  if (confirm('确认清除屏幕内容?')) {
    await write(EpdCmd.CLEAR);
    addLog("清屏指令已发送！");
    addLog("屏幕刷新完成前请不要操作。");
  }
}

async function sendcmd() {
  const cmdTXT = document.getElementById('cmdTXT').value;
  if (cmdTXT == '') return;
  const bytes = hex2bytes(cmdTXT);
  await write(bytes[0], bytes.length > 1 ? bytes.slice(1) : null);
}

// 替换为渲染文本到画布并发送图像的功能
async function sendMemo() {
  const memoText = document.getElementById('memoText').value.trim();
  if (!memoText) {
    addLog("备忘录内容不能为空");
    return;
  }
  
  // 保存到本地存储
  const fontSize = parseInt(document.getElementById('memoFontSize').value);
  const memoTitle = document.getElementById('memoTitle').value;
  const titlePosition = document.getElementById('titlePosition').value;
  const memoFont = document.getElementById('memoFont').value;
  
  localStorage.setItem('memoText', memoText);
  localStorage.setItem('memoFontSize', fontSize.toString());
  localStorage.setItem('memoTitle', memoTitle);
  localStorage.setItem('titlePosition', titlePosition);
  localStorage.setItem('memoFont', memoFont);
  
  // 渲染文本到画布
  renderMemoToCanvas(memoText, fontSize);
  
  // 使用现有的发送图像功能
  await sendimg(true);
}

// 应用文本格式化
function applyMemoFormat(format) {
  const textarea = document.getElementById('memoText');
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selectedText = textarea.value.substring(start, end);
  let replacement = '';
  
  switch (format) {
    case 'bold':
      replacement = `**${selectedText}**`;
      break;
    case 'italic':
      replacement = `*${selectedText}*`;
      break;
    case 'underline':
      replacement = `_${selectedText}_`;
      break;
    case 'bullet':
      // 如果有多行选择，为每行添加项目符号
      if (selectedText.includes('\n')) {
        replacement = selectedText.split('\n').map(line => `• ${line}`).join('\n');
      } else {
        replacement = `• ${selectedText}`;
      }
      break;
    case 'number':
      // 如果有多行选择，为每行添加编号
      if (selectedText.includes('\n')) {
        replacement = selectedText.split('\n').map((line, i) => `${i+1}. ${line}`).join('\n');
      } else {
        replacement = `1. ${selectedText}`;
      }
      break;
    case 'checkbox':
      // 如果有多行选择，为每行添加复选框
      if (selectedText.includes('\n')) {
        replacement = selectedText.split('\n').map(line => `[ ] ${line}`).join('\n');
      } else {
        replacement = `[ ] ${selectedText}`;
      }
      break;
    case 'today':
      const today = new Date();
      const formattedDate = today.toLocaleDateString();
      replacement = formattedDate;
      break;
  }
  
  // 替换文本
  textarea.value = 
    textarea.value.substring(0, start) + 
    replacement + 
    textarea.value.substring(end);
  
  // 调整光标位置到插入内容之后
  textarea.selectionStart = start + replacement.length;
  textarea.selectionEnd = start + replacement.length;
  
  // 使文本框重新获得焦点
  textarea.focus();
  
  // 更新字符计数
  updateCharCount();
}

// 预览备忘录内容
function previewMemo() {
  const memoText = document.getElementById('memoText').value;
  const previewDiv = document.getElementById('memo-preview');
  const previewContent = document.getElementById('memo-preview-content');
  
  if (!memoText) {
    alert('请先输入备忘录内容');
    return;
  }
  
  // 处理简单的Markdown标记
  let htmlContent = memoText
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // 粗体
    .replace(/\*(.*?)\*/g, '<em>$1</em>') // 斜体
    .replace(/_(.*?)_/g, '<u>$1</u>') // 下划线
    .replace(/\[ \] (.*?)(?:\n|$)/g, '<div><input type="checkbox" disabled> $1</div>') // 未选中复选框
    .replace(/\[x\] (.*?)(?:\n|$)/g, '<div><input type="checkbox" checked disabled> $1</div>') // 已选中复选框
    .replace(/^• (.*?)(?:\n|$)/gm, '<li>$1</li>') // 项目符号
    .replace(/^(\d+)\. (.*?)(?:\n|$)/gm, '<li>$1. $2</li>') // 编号列表
    .replace(/\n/g, '<br>'); // 换行符
  
  // 添加适当的列表标签
  htmlContent = htmlContent.replace(/<li>.*?<\/li>/g, match => {
    if (match.includes('•')) {
      return `<ul>${match}</ul>`;
    } else if (/\d+\./.test(match)) {
      return `<ol>${match}</ol>`;
    }
    return match;
  });
  
  previewContent.innerHTML = htmlContent;
  previewDiv.style.display = 'block';
}

// 渲染备忘录文本到画布
function renderMemoToCanvas(text, fontSize) {
  // 确保我们使用主画布
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  
  // 清空画布
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // 设置文本样式
  ctx.fillStyle = 'black';
  const fontFamily = document.getElementById('memoFont').value;
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textBaseline = 'top';
  
  // 设置行高和边距
  const lineHeight = fontSize * 1.2;
  const margin = 20;
  
  let y = margin;
  
  // 处理标题
  const title = document.getElementById('memoTitle').value;
  if (title) {
    const titlePosition = document.getElementById('titlePosition').value;
    const titleFontSize = fontSize * 1.5;
    ctx.font = `bold ${titleFontSize}px ${fontFamily}`;
    
    const titleWidth = ctx.measureText(title).width;
    let titleX = margin;
    
    switch (titlePosition) {
      case 'top':
        titleX = (canvas.width - titleWidth) / 2;
        break;
      case 'top-right':
        titleX = canvas.width - margin - titleWidth;
        break;
      case 'top-left':
      default:
        titleX = margin;
    }
    
    ctx.fillText(title, titleX, y);
    
    // 在标题下方画一条线
    ctx.beginPath();
    ctx.moveTo(margin, y + titleFontSize + 5);
    ctx.lineTo(canvas.width - margin, y + titleFontSize + 5);
    ctx.stroke();
    
    y += titleFontSize + 15; // 标题后多加一些间距
  }
  
  // 恢复正常字体大小
  ctx.font = `${fontSize}px ${fontFamily}`;
  
  // 处理简单的Markdown格式
  const lines = text.split('\n');
  
  // 为不同格式设置不同字体样式
  const normalFont = `${fontSize}px ${fontFamily}`;
  const boldFont = `bold ${fontSize}px ${fontFamily}`;
  const italicFont = `italic ${fontSize}px ${fontFamily}`;
  const boldItalicFont = `bold italic ${fontSize}px ${fontFamily}`;
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let x = margin;
    
    // 检查特殊格式
    if (line.startsWith('• ')) {
      // 绘制项目符号
      ctx.font = normalFont;
      ctx.fillText('•', x, y);
      x += fontSize; // 缩进
      line = line.substring(2);
    } else if (/^\d+\./.test(line)) {
      // 绘制数字列表
      const match = line.match(/^(\d+)\./);
      if (match) {
        ctx.font = normalFont;
        ctx.fillText(match[0], x, y);
        x += ctx.measureText(match[0]).width + 5;
        line = line.substring(match[0].length + 1);
      }
    } else if (line.startsWith('[ ] ') || line.startsWith('[x] ')) {
      // 绘制复选框
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      const boxSize = fontSize * 0.8;
      ctx.strokeRect(x, y + (lineHeight - boxSize) / 2, boxSize, boxSize);
      
      if (line.startsWith('[x] ')) {
        // 绘制选中标记
        ctx.beginPath();
        ctx.moveTo(x + boxSize * 0.2, y + lineHeight / 2);
        ctx.lineTo(x + boxSize * 0.4, y + lineHeight / 2 + boxSize * 0.2);
        ctx.lineTo(x + boxSize * 0.8, y + lineHeight / 2 - boxSize * 0.3);
        ctx.stroke();
      }
      
      x += boxSize + 5;
      line = line.substring(4); // 跳过 "[ ] " 或 "[x] "
    }
    
    // 处理行内格式
    let segments = [];
    let currentIndex = 0;
    
    // 查找粗体、斜体等标记
    const regex = /(\*\*.*?\*\*)|(\*.*?\*)|(_.*?_)/g;
    let match;
    
    while ((match = regex.exec(line)) !== null) {
      // 添加前面的普通文本
      if (match.index > currentIndex) {
        segments.push({
          text: line.substring(currentIndex, match.index),
          format: 'normal'
        });
      }
      
      // 添加格式化文本
      if (match[1]) { // 粗体 **text**
        segments.push({
          text: match[1].substring(2, match[1].length - 2),
          format: 'bold'
        });
      } else if (match[2]) { // 斜体 *text*
        segments.push({
          text: match[2].substring(1, match[2].length - 1),
          format: 'italic'
        });
      } else if (match[3]) { // 下划线 _text_
        segments.push({
          text: match[3].substring(1, match[3].length - 1),
          format: 'underline'
        });
      }
      
      currentIndex = match.index + match[0].length;
    }
    
    // 添加剩余的文本
    if (currentIndex < line.length) {
      segments.push({
        text: line.substring(currentIndex),
        format: 'normal'
      });
    }
    
    // 如果没有匹配到任何格式，就添加整行作为普通文本
    if (segments.length === 0) {
      segments.push({
        text: line,
        format: 'normal'
      });
    }
    
    // 绘制每个文本片段
    for (const segment of segments) {
      switch (segment.format) {
        case 'bold':
          ctx.font = boldFont;
          break;
        case 'italic':
          ctx.font = italicFont;
          break;
        case 'underline':
          ctx.font = normalFont;
          break;
        default:
          ctx.font = normalFont;
      }
      
      // 测量文本宽度
      const textWidth = ctx.measureText(segment.text).width;
      
      // 如果这一段文本会超出右边界，就换行
      if (x + textWidth > canvas.width - margin) {
        y += lineHeight;
        x = margin;
      }
      
      // 绘制文本
      ctx.fillText(segment.text, x, y);
      
      // 绘制下划线
      if (segment.format === 'underline') {
        const metrics = ctx.measureText(segment.text);
        const underlineY = y + fontSize - fontSize / 8;
        ctx.beginPath();
        ctx.moveTo(x, underlineY);
        ctx.lineTo(x + metrics.width, underlineY);
        ctx.stroke();
      }
      
      x += ctx.measureText(segment.text).width;
    }
    
    // 下一行
    y += lineHeight;
    
    // 如果已经到达画布底部，停止渲染
    if (y > canvas.height - margin && i < lines.length - 1) {
      addLog("警告：文本太长，部分内容可能无法显示");
      return;
    }
  }
  
  addLog("备忘录已渲染到画布！");
}

// 加载保存的备忘录内容
function loadSavedMemo() {
  const savedText = localStorage.getItem('memoText');
  const savedFontSize = localStorage.getItem('memoFontSize');
  const savedTitle = localStorage.getItem('memoTitle');
  const savedTitlePosition = localStorage.getItem('titlePosition');
  const savedFont = localStorage.getItem('memoFont');
  
  if (savedText) {
    document.getElementById('memoText').value = savedText;
    updateCharCount();
  }
  
  if (savedFontSize) {
    document.getElementById('memoFontSize').value = savedFontSize;
  }
  
  if (savedTitle) {
    document.getElementById('memoTitle').value = savedTitle;
  }
  
  if (savedTitlePosition) {
    document.getElementById('titlePosition').value = savedTitlePosition;
  }
  
  if (savedFont) {
    document.getElementById('memoFont').value = savedFont;
  }
}

// 更新字符计数
function updateCharCount() {
  const memoText = document.getElementById('memoText').value;
  const charCount = memoText.length;
  document.getElementById('charCount').textContent = `${charCount}/1024`;
  
  // 如果超过1024个字符，显示警告
  if (charCount > 1024) {
    document.getElementById('charCount').classList.add('warning');
  } else {
    document.getElementById('charCount').classList.remove('warning');
  }
}

function downloadDataArray() {
  const mode = document.getElementById('ditherMode').value;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const processedData = processImageData(imageData, mode);

  if (mode === 'sixColor' && processedData.length !== canvas.width * canvas.height) {
    console.log(`错误：预期${canvas.width * canvas.height}字节，但得到${processedData.length}字节`);
    addLog('数组大小不匹配。请检查图像尺寸和模式。');
    return;
  }

  const dataLines = [];
  for (let i = 0; i < processedData.length; i++) {
    const hexValue = (processedData[i] & 0xff).toString(16).padStart(2, '0');
    dataLines.push(`0x${hexValue}`);
  }

  const formattedData = [];
  for (let i = 0; i < dataLines.length; i += 16) {
    formattedData.push(dataLines.slice(i, i + 16).join(', '));
  }

  const colorModeValue = mode === 'sixColor' ? 0 : mode === 'fourColor' ? 1 : mode === 'blackWhiteColor' ? 2 : 3;
  const arrayContent = [
    'const uint8_t imageData[] PROGMEM = {',
    formattedData.join(',\n'),
    '};',
    `const uint16_t imageWidth = ${canvas.width};`,
    `const uint16_t imageHeight = ${canvas.height};`,
    `const uint8_t colorMode = ${colorModeValue};`
  ].join('\n');

  const blob = new Blob([arrayContent], { type: 'text/plain' });
  const link = document.createElement('a');
  link.download = 'imagedata.h';
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
}

function updateButtonStatus(forceDisabled = false) {
  const connected = gattServer != null && gattServer.connected;
  const status = forceDisabled ? 'disabled' : (connected ? null : 'disabled');
  document.getElementById("reconnectbutton").disabled = (gattServer == null || gattServer.connected) ? 'disabled' : null;
  document.getElementById("sendcmdbutton").disabled = status;
  document.getElementById("calendarmodebutton").disabled = status;
  document.getElementById("clockmodebutton").disabled = status;
  document.getElementById("clearscreenbutton").disabled = status;
  document.getElementById("sendimgbutton").disabled = status;
  document.getElementById("setDriverbutton").disabled = status;
  document.getElementById("sendMemoButton").disabled = status; // 新增备忘录按钮状态
}

function disconnect() {
  updateButtonStatus();
  resetVariables();
  addLog('已断开连接.');
  document.getElementById("connectbutton").innerHTML = '连接';
}

async function preConnect() {
  if (gattServer != null && gattServer.connected) {
    if (bleDevice != null && bleDevice.gatt.connected) {
      bleDevice.gatt.disconnect();
    }
  }
  else {
    resetVariables();
    try {
      bleDevice = await navigator.bluetooth.requestDevice({
        optionalServices: ['62750001-d828-918d-fb46-b6c11c675aec'],
        acceptAllDevices: true
      });
    } catch (e) {
      console.error(e);
      if (e.message) addLog("requestDevice: " + e.message);
      addLog("请检查蓝牙是否已开启，且使用的浏览器支持蓝牙！建议使用以下浏览器：");
      addLog("• 电脑: Chrome/Edge");
      addLog("• Android: Chrome/Edge");
      addLog("• iOS: Bluefy 浏览器");
      return;
    }

    await bleDevice.addEventListener('gattserverdisconnected', disconnect);
    setTimeout(async function () { await connect(); }, 300);
  }
}

async function reConnect() {
  if (bleDevice != null && bleDevice.gatt.connected)
    bleDevice.gatt.disconnect();
  resetVariables();
  addLog("正在重连");
  setTimeout(async function () { await connect(); }, 300);
}

function handleNotify(value, idx) {
  const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (idx == 0) {
    addLog(`收到配置：${bytes2hex(data)}`);
    const epdpins = document.getElementById("epdpins");
    const epddriver = document.getElementById("epddriver");
    epdpins.value = bytes2hex(data.slice(0, 7));
    if (data.length > 10) epdpins.value += bytes2hex(data.slice(10, 11));
    epddriver.value = bytes2hex(data.slice(7, 8));
    updateDitcherOptions();
  } else {
    if (textDecoder == null) textDecoder = new TextDecoder();
    const msg = textDecoder.decode(data);
    addLog(msg, '⇓');
    if (msg.startsWith('mtu=') && msg.length > 4) {
      const mtuSize = parseInt(msg.substring(4));
      document.getElementById('mtusize').value = mtuSize;
      addLog(`MTU 已更新为: ${mtuSize}`);
    } else if (msg.startsWith('t=') && msg.length > 2) {
      const t = parseInt(msg.substring(2)) + new Date().getTimezoneOffset() * 60;
      addLog(`远端时间: ${new Date(t * 1000).toLocaleString()}`);
      addLog(`本地时间: ${new Date().toLocaleString()}`);
    }
  }
}

async function connect() {
  if (bleDevice == null || epdCharacteristic != null) return;

  try {
    addLog("正在连接: " + bleDevice.name);
    gattServer = await bleDevice.gatt.connect();
    addLog('  找到 GATT Server');
    epdService = await gattServer.getPrimaryService('62750001-d828-918d-fb46-b6c11c675aec');
    addLog('  找到 EPD Service');
    epdCharacteristic = await epdService.getCharacteristic('62750002-d828-918d-fb46-b6c11c675aec');
    addLog('  找到 Characteristic');
  } catch (e) {
    console.error(e);
    if (e.message) addLog("connect: " + e.message);
    disconnect();
    return;
  }

  try {
    const versionCharacteristic = await epdService.getCharacteristic('62750003-d828-918d-fb46-b6c11c675aec');
    const versionData = await versionCharacteristic.readValue();
    appVersion = versionData.getUint8(0);
    addLog(`固件版本: 0x${appVersion.toString(16)}`);
  } catch (e) {
    console.error(e);
    appVersion = 0x15;
  }

  if (appVersion < 0x16) {
    const oldURL = "https://tsl0922.github.io/EPD-nRF5/v1.5";
    alert("!!!注意!!!\n当前固件版本过低，可能无法正常使用部分功能，建议升级到最新版本。");
    if (confirm('是否访问旧版本上位机？')) location.href = oldURL;
    setTimeout(() => {
      addLog(`如遇到问题，可访问旧版本上位机: ${oldURL}`);
    }, 500);
  }

  try {
    await epdCharacteristic.startNotifications();
    epdCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
      handleNotify(event.target.value, msgIndex++);
    });
  } catch (e) {
    console.error(e);
    if (e.message) addLog("startNotifications: " + e.message);
  }

  await write(EpdCmd.INIT);

  document.getElementById("connectbutton").innerHTML = '断开';
  updateButtonStatus();
}

function setStatus(statusText) {
  document.getElementById("status").innerHTML = statusText;
}

function addLog(logTXT, action = '') {
  const log = document.getElementById("log");
  const now = new Date();
  const time = String(now.getHours()).padStart(2, '0') + ":" +
    String(now.getMinutes()).padStart(2, '0') + ":" +
    String(now.getSeconds()).padStart(2, '0') + " ";

  const logEntry = document.createElement('div');
  const timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.textContent = time;
  logEntry.appendChild(timeSpan);

  if (action !== '') {
    const actionSpan = document.createElement('span');
    actionSpan.className = 'action';
    actionSpan.innerHTML = action;
    logEntry.appendChild(actionSpan);
  }
  logEntry.appendChild(document.createTextNode(logTXT));

  log.appendChild(logEntry);
  log.scrollTop = log.scrollHeight;

  while (log.childNodes.length > 20) {
    log.removeChild(log.firstChild);
  }
}

function clearLog() {
  document.getElementById("log").innerHTML = '';
}

function updateCanvasSize() {
  const selectedSizeName = document.getElementById('canvasSize').value;
  const selectedSize = canvasSizes.find(size => size.name === selectedSizeName);

  canvas.width = selectedSize.width;
  canvas.height = selectedSize.height;

  updateImage(false);
}

function updateDitcherOptions() {
  const epdDriverSelect = document.getElementById('epddriver');
  const selectedOption = epdDriverSelect.options[epdDriverSelect.selectedIndex];
  const colorMode = selectedOption.getAttribute('data-color');
  const canvasSize = selectedOption.getAttribute('data-size');

  if (colorMode) document.getElementById('ditherMode').value = colorMode;
  if (canvasSize) document.getElementById('canvasSize').value = canvasSize;

  updateCanvasSize(); // always update image
}

function updateImage(clear = false) {
  const imageFile = document.getElementById('imageFile');
  if (imageFile.files.length == 0) return;

  if (clear) clearCanvas();

  const file = imageFile.files[0];
  let image = new Image();;
  image.src = URL.createObjectURL(file);
  image.onload = function (event) {
    URL.revokeObjectURL(this.src);
    ctx.drawImage(image, 0, 0, image.width, image.height, 0, 0, canvas.width, canvas.height);

    // Redraw text and lines
    redrawTextElements();
    redrawLineSegments();

    convertDithering()
  }
}

function clearCanvas() {
  if (confirm('清除画布已有内容?')) {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    textElements = []; // Clear stored text positions
    lineSegments = []; // Clear stored line segments
    return true;
  }
  return false;
}

function convertDithering() {
  const contrast = parseFloat(document.getElementById('ditherContrast').value);
  const currentImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const imageData = new ImageData(
    new Uint8ClampedArray(currentImageData.data),
    currentImageData.width,
    currentImageData.height
  );

  adjustContrast(imageData, contrast);

  const alg = document.getElementById('ditherAlg').value;
  const strength = parseFloat(document.getElementById('ditherStrength').value);
  const mode = document.getElementById('ditherMode').value;
  const processedData = processImageData(ditherImage(imageData, alg, strength, mode), mode);
  const finalImageData = decodeProcessedData(processedData, canvas.width, canvas.height, mode);
  ctx.putImageData(finalImageData, 0, 0);
}

function initEventHandlers() {
  document.getElementById("epddriver").addEventListener("change", updateDitcherOptions);
  document.getElementById("imageFile").addEventListener("change", function () { updateImage(true); });
  document.getElementById("ditherMode").addEventListener("change", function () { updateImage(false); });
  document.getElementById("ditherAlg").addEventListener("change", function () { updateImage(false); });
  document.getElementById("ditherStrength").addEventListener("input", function () {
    updateImage(false);
    document.getElementById("ditherStrengthValue").innerText = parseFloat(this.value).toFixed(1);
  });
  document.getElementById("ditherContrast").addEventListener("input", function () {
    updateImage(false);
    document.getElementById("ditherContrastValue").innerText = parseFloat(this.value).toFixed(1);
  });
  document.getElementById("canvasSize").addEventListener("change", updateCanvasSize);
}

function checkDebugMode() {
  const link = document.getElementById('debug-toggle');
  const urlParams = new URLSearchParams(window.location.search);
  const debugMode = urlParams.get('debug');

  if (debugMode === 'true') {
    document.body.classList.add('debug-mode');
    link.innerHTML = '正常模式';
    link.setAttribute('href', window.location.pathname);
    addLog("注意：开发模式功能已开启！不懂请不要随意修改，否则后果自负！");
  } else {
    document.body.classList.remove('debug-mode');
    link.innerHTML = '开发模式';
    link.setAttribute('href', window.location.pathname + '?debug=true');
  }
}

// 应用备忘录模板
function applyTemplate() {
  const template = document.getElementById('memoTemplate').value;
  const memoText = document.getElementById('memoText');
  const memoTitle = document.getElementById('memoTitle');
  
  if (!template) return;
  
  if ((memoText.value || memoTitle.value) && !confirm('将覆盖当前内容，是否继续？')) {
    document.getElementById('memoTemplate').value = '';
    return;
  }
  
  const today = new Date().toLocaleDateString();
  
  switch (template) {
    case 'todo':
      memoTitle.value = "今日待办";
      memoText.value = "[ ] 1. \n[ ] 2. \n[ ] 3. \n[ ] 4. \n[ ] 5. \n\n日期：" + today;
      break;
    case 'notes':
      memoTitle.value = "会议笔记";
      memoText.value = "日期：" + today + "\n\n主题：\n\n要点：\n• \n• \n• \n\n后续行动：\n• ";
      break;
    case 'shopping':
      memoTitle.value = "购物清单";
      memoText.value = "[ ] 1. \n[ ] 2. \n[ ] 3. \n[ ] 4. \n[ ] 5. \n\n备注：";
      break;
  }
  
  // 重置选择
  document.getElementById('memoTemplate').value = '';
  updateCharCount();
}

// 清空备忘录内容
function clearMemo() {
  if (confirm('确定要清空备忘录内容吗？')) {
    document.getElementById('memoText').value = '';
    updateCharCount();
  }
}

// 修改sendimg函数支持不显示确认对话框的选项
async function sendimg(skipConfirmation = false) {
  const canvasSize = document.getElementById('canvasSize').value;
  const ditherMode = document.getElementById('ditherMode').value;
  const epdDriverSelect = document.getElementById('epddriver');
  const selectedOption = epdDriverSelect.options[epdDriverSelect.selectedIndex];

  if (!skipConfirmation) {
    if (selectedOption.getAttribute('data-size') !== canvasSize) {
      if (!confirm("警告：画布尺寸和驱动不匹配，是否继续？")) return;
    }
    if (selectedOption.getAttribute('data-color') !== ditherMode) {
      if (!confirm("警告：颜色模式和驱动不匹配，是否继续？")) return;
    }
  }

  startTime = new Date().getTime();
  const status = document.getElementById("status");
  status.parentElement.style.display = "block";

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const processedData = processImageData(imageData, ditherMode);

  updateButtonStatus(true);

  if (ditherMode === 'fourColor') {
    await writeImage(processedData, 'color');
  } else if (ditherMode === 'threeColor') {
    const halfLength = Math.floor(processedData.length / 2);
    await writeImage(processedData.slice(0, halfLength), 'bw');
    await writeImage(processedData.slice(halfLength), 'red');
  } else if (ditherMode === 'blackWhiteColor') {
    await writeImage(processedData, 'bw');
  } else {
    addLog("当前固件不支持此颜色模式。");
    updateButtonStatus();
    return;
  }

  await write(EpdCmd.REFRESH);
  updateButtonStatus();

  const sendTime = (new Date().getTime() - startTime) / 1000.0;
  addLog(`发送完成！耗时: ${sendTime}s`);
  setStatus(`发送完成！耗时: ${sendTime}s`);
  addLog("屏幕刷新完成前请不要操作。");
  setTimeout(() => {
    status.parentElement.style.display = "none";
  }, 5000);
}

document.body.onload = () => {
  textDecoder = null;
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext("2d");

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  initPaintTools();
  initEventHandlers();
  updateButtonStatus();
  checkDebugMode();
  loadSavedMemo(); // 加载保存的备忘录内容
  
  // 添加备忘录文本框的事件监听器
  document.getElementById('memoText').addEventListener('input', updateCharCount);
}