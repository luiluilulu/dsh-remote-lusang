import { Crop, Paintbrush, RotateCcw, Trash2, Undo2, X } from 'lucide-react-native'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { strings } from '../../locales/i18n'
import type { PromptImage } from '../../types'
import { Button, IconButton } from '../../ui/components'
import { radius, spacing, type as typography } from '../../ui/theme'
import { useTheme } from '../../ui/theme-context'
/** Canvas output: always JPEG, cropped to the box the user kept. */
export interface ImageEditorExport {
  base64: string
  width: number
  height: number
}
type Phase = 'loading' | 'ready' | 'exporting' | 'failed'
type Mode = 'crop' | 'draw'
interface Transfer {
  id: string
  sent: number
  total: number
  timer?: ReturnType<typeof setTimeout>
}
interface Export {
  total: number
  chunks: string[]
  width: number
  height: number
  timer?: ReturnType<typeof setTimeout>
}
interface Message {
  type?: string
  id?: string
  index?: number
  total?: number
  width?: number
  height?: number
  data?: string
  canUndo?: boolean
}
/** Must match `CHUNK` in the embedded page script. */
const CHUNK_CHARS = 64 * 1024
const READY_TIMEOUT_MS = 30000
const CHUNK_TIMEOUT_MS = 12000
const RENDER_TIMEOUT_MS = 20000
const EXPORT_TIMEOUT_MS = 30000
/** The renderer downscales larger sources before editing; JPEG output keeps this budget. */
const MAX_WORK_EDGE = 3072
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Offline fallback editor (no ACTION_EDIT handler): crop + blue strokes + undo/clear,
 * JPEG export. Image and result move over the bridge in acknowledged chunks so a
 * multi-megabyte data URL never becomes one giant evaluateJavascript call.
 */
const EDITOR_HTML = String.raw`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:__STAGE_BG__;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}#stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}#canvas{display:block;touch-action:none}</style>
</head><body><div id="stage"><canvas id="canvas"></canvas></div><script>
(function(){
'use strict';
var CHUNK=65536,MAX_EDGE=__MAX_EDGE__,BRUSH='#2F6BFF';
var stage=document.getElementById('stage'),canvas=document.getElementById('canvas'),ctx=canvas.getContext('2d');
var base=document.createElement('canvas'),baseCtx=base.getContext('2d');
var image=null,workW=0,workH=0,scale=1,mode='crop',crop={x:0,y:0,w:0,h:0},strokes=[],current=null,drag=null;
var transfer={id:null,mime:'image/jpeg',chunks:[]},exportState=null;
function send(type,payload){try{window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({type:type},payload||{})))}catch(e){}}
function clamp(v,lo,hi){return v<lo?lo:v>hi?hi:v}
function lineWidth(){return Math.max(2.5,4.5/(scale||1))}
function layout(){if(!image)return;var r=stage.getBoundingClientRect(),aw=Math.max(1,r.width-8),ah=Math.max(1,r.height-8);scale=Math.min(aw/workW,ah/workH);if(!isFinite(scale)||scale<=0)scale=1;canvas.style.width=Math.max(1,Math.round(workW*scale))+'px';canvas.style.height=Math.max(1,Math.round(workH*scale))+'px';render()}
function stroke(target,item){var p=item.pts;target.strokeStyle=BRUSH;target.fillStyle=BRUSH;target.lineCap='round';target.lineJoin='round';target.lineWidth=item.w;if(p.length<4){if(p.length===2){target.beginPath();target.arc(p[0],p[1],item.w/2,0,Math.PI*2);target.fill()}return}target.beginPath();target.moveTo(p[0],p[1]);for(var i=2;i<p.length;i+=2)target.lineTo(p[i],p[i+1]);target.stroke()}
function overlay(){var h=Math.max(1,1.5/(scale||1));ctx.save();ctx.fillStyle='rgba(15,17,21,.58)';ctx.fillRect(0,0,workW,crop.y);ctx.fillRect(0,crop.y+crop.h,workW,Math.max(0,workH-crop.y-crop.h));ctx.fillRect(0,crop.y,crop.x,crop.h);ctx.fillRect(crop.x+crop.w,crop.y,Math.max(0,workW-crop.x-crop.w),crop.h);ctx.strokeStyle='#fff';ctx.lineWidth=h*2;ctx.strokeRect(crop.x+h/2,crop.y+h/2,Math.max(0,crop.w-h),Math.max(0,crop.h-h));var s=10/(scale||1);ctx.fillStyle='#fff';var corners=[[crop.x,crop.y],[crop.x+crop.w,crop.y],[crop.x,crop.y+crop.h],[crop.x+crop.w,crop.y+crop.h]];for(var i=0;i<4;i++)ctx.fillRect(clamp(corners[i][0]-s/2,0,workW-s),clamp(corners[i][1]-s/2,0,workH-s),s,s);ctx.restore()}
function render(){if(!image)return;ctx.clearRect(0,0,workW,workH);ctx.drawImage(base,0,0);for(var i=0;i<strokes.length;i++)stroke(ctx,strokes[i]);if(current)stroke(ctx,current);if(mode==='crop')overlay()}
function point(e){var r=canvas.getBoundingClientRect(),s=e;if(e.touches&&e.touches.length>0)s=e.touches[0];return{x:(s.clientX-r.left)*workW/Math.max(1,r.width),y:(s.clientY-r.top)*workH/Math.max(1,r.height)}}
function hit(p){var h=24/(scale||1),c=[[crop.x,crop.y,crop.x+crop.w,crop.y+crop.h],[crop.x+crop.w,crop.y,crop.x,crop.y+crop.h],[crop.x,crop.y+crop.h,crop.x+crop.w,crop.y],[crop.x+crop.w,crop.y+crop.h,crop.x,crop.y]];for(var i=0;i<4;i++){if(Math.abs(p.x-c[i][0])<=h&&Math.abs(p.y-c[i][1])<=h)return{kind:'resize',ax:c[i][2],ay:c[i][3]}}if(p.x>=crop.x&&p.x<=crop.x+crop.w&&p.y>=crop.y&&p.y<=crop.y+crop.h)return{kind:'move',sx:crop.x,sy:crop.y,px:p.x,py:p.y,w:crop.w,h:crop.h};return null}
function resize(d,p){var m=Math.max(24,Math.max(workW,workH)*0.06),x=clamp(p.x,0,workW),y=clamp(p.y,0,workH),l=Math.min(d.ax,x),r=Math.max(d.ax,x),t=Math.min(d.ay,y),b=Math.max(d.ay,y);if(r-l<m){if(x>=d.ax)r=Math.min(workW,l+m);else l=Math.max(0,r-m)}if(b-t<m){if(y>=d.ay)b=Math.min(workH,t+m);else t=Math.max(0,b-m)}crop={x:l,y:t,w:r-l,h:b-t}}
function moveCrop(d,p){crop.x=clamp(d.sx+(p.x-d.px),0,Math.max(0,workW-d.w));crop.y=clamp(d.sy+(p.y-d.py),0,Math.max(0,workH-d.h));crop.w=d.w;crop.h=d.h}
function append(p){var pts=current.pts,lx=pts[pts.length-2],ly=pts[pts.length-1],dx=p.x-lx,dy=p.y-ly;if(dx*dx+dy*dy<1)return;ctx.strokeStyle=BRUSH;ctx.lineCap='round';ctx.lineJoin='round';ctx.lineWidth=current.w;ctx.beginPath();ctx.moveTo(lx,ly);ctx.lineTo(p.x,p.y);ctx.stroke();pts.push(p.x,p.y)}
function down(e){if(!image||drag)return;if(e.preventDefault)e.preventDefault();var p=point(e);if(mode==='draw'){current={w:lineWidth(),pts:[p.x,p.y]};drag={kind:'draw'}}else drag=hit(p)}
function move(e){if(!image||!drag)return;if(e.preventDefault)e.preventDefault();var p=point(e);if(drag.kind==='draw'){append(p);return}if(drag.kind==='resize')resize(drag,p);else moveCrop(drag,p);render()}
function up(){if(drag&&drag.kind==='draw'&&current){if(current.pts.length===2)stroke(ctx,current);strokes.push(current);current=null;drag=null;send('state',{canUndo:true});return}drag=null}
function setup(w,h){if(!w||!h){send('error',{});return}var s=Math.min(1,MAX_EDGE/Math.max(w,h));workW=Math.max(1,Math.round(w*s));workH=Math.max(1,Math.round(h*s));canvas.width=workW;canvas.height=workH;base.width=workW;base.height=workH;baseCtx.drawImage(image,0,0,workW,workH);crop={x:0,y:0,w:workW,h:workH};strokes=[];current=null;drag=null;mode='crop';layout();send('image-ready',{width:workW,height:workH});send('state',{canUndo:false})}
function nextChunk(){if(!exportState)return;if(exportState.sent>=exportState.chunks.length){exportState=null;send('export-end',{});return}send('export-chunk',{index:exportState.sent,data:exportState.chunks[exportState.sent]})}
function exportImage(){if(!image||exportState)return;var cw=Math.max(1,Math.round(crop.w)),ch=Math.max(1,Math.round(crop.h)),out=document.createElement('canvas');out.width=cw;out.height=ch;var o=out.getContext('2d');o.fillStyle='#fff';o.fillRect(0,0,cw,ch);o.drawImage(base,crop.x,crop.y,crop.w,crop.h,0,0,cw,ch);o.save();o.beginPath();o.rect(0,0,cw,ch);o.clip();o.translate(-crop.x,-crop.y);for(var i=0;i<strokes.length;i++)stroke(o,strokes[i]);o.restore();var url;try{url=out.toDataURL('image/jpeg',0.85)}catch(e){send('error',{});return}var payload=url.slice(url.indexOf(',')+1),chunks=[];for(var j=0;j<payload.length;j+=CHUNK)chunks.push(payload.slice(j,j+CHUNK));exportState={chunks:chunks,sent:0};send('export-start',{total:chunks.length,width:cw,height:ch});nextChunk()}
window.beginImage=function(id,mime){transfer={id:String(id),mime:typeof mime==='string'&&mime.indexOf('image/')===0?mime:'image/jpeg',chunks:[]}};
window.appendImageChunk=function(id,index,chunk){if(transfer.id!==String(id)||index!==transfer.chunks.length)return;transfer.chunks.push(String(chunk));send('image-ack',{index:index})};
window.finishImage=function(id){if(transfer.id!==String(id)||!transfer.chunks.length)return;var payload=transfer.chunks.join(''),mime=transfer.mime;transfer={id:null,mime:'image/jpeg',chunks:[]};var img=new Image();img.onload=function(){image=img;setup(img.naturalWidth||img.width,img.naturalHeight||img.height)};img.onerror=function(){send('error',{})};img.src='data:'+mime+';base64,'+payload};
window.ackExportChunk=function(index){if(!exportState||index!==exportState.sent)return;exportState.sent++;nextChunk()};
window.setMode=function(next){if(next!=='draw'&&next!=='crop')return;if(mode===next)return;mode=next;current=null;drag=null;render()};
window.undo=function(){if(!strokes.length)return;strokes.pop();render();send('state',{canUndo:strokes.length>0})};
window.clearStrokes=function(){if(!strokes.length&&!current)return;strokes=[];current=null;render();send('state',{canUndo:false})};
window.resetCrop=function(){if(!image)return;crop={x:0,y:0,w:workW,h:workH};render()};
window.exportImage=exportImage;
window.addEventListener('resize',function(){if(image)layout()});
if(window.PointerEvent){canvas.addEventListener('pointerdown',function(e){if(canvas.setPointerCapture){try{canvas.setPointerCapture(e.pointerId)}catch(err){}}down(e)});canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up)}else{canvas.addEventListener('touchstart',down,{passive:false});canvas.addEventListener('touchmove',move,{passive:false});canvas.addEventListener('touchend',up);canvas.addEventListener('touchcancel',up)}
send('page-ready');
})();
</script></body></html>`

export function ImageEditor({
  source,
  maxEdge,
  onCancel,
  onSave,
}: {
  source: PromptImage
  /** Longest allowed output edge; larger sources are downscaled before editing. */
  maxEdge: number
  onCancel: () => void
  /** Returns an error message to keep the editor open; `undefined` closes it. */
  onSave: (exported: ImageEditorExport) => string | undefined
}) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const styles = useMemo(() => createStyles(colors), [colors])
  const web = useRef<WebView>(null)
  const transfer = useRef<Transfer | undefined>(undefined)
  const exporting = useRef<Export | undefined>(undefined)
  const terminal = useRef(false)
  const [revision, setRevision] = useState(0)
  const [phase, setPhase] = useState<Phase>('loading')
  const [mode, setMode] = useState<Mode>('crop')
  const [canUndo, setCanUndo] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const phaseRef = useRef<Phase>('loading')
  phaseRef.current = phase

  const html = useMemo(
    () => EDITOR_HTML.replace('__MAX_EDGE__', String(Math.max(512, Math.round(maxEdge)))).replace('__STAGE_BG__', colors.background),
    [maxEdge, colors.background],
  )
  const webSource = useMemo(() => ({ html, baseUrl: 'about:blank' }), [html])
  const send = (script: string) => web.current?.injectJavaScript(`${script};true;`)
  const clear = (slot: { timer?: ReturnType<typeof setTimeout> }) => {
    if (slot.timer !== undefined) clearTimeout(slot.timer)
    slot.timer = undefined
  }
  const stop = (message: string) => {
    if (terminal.current) return
    terminal.current = true
    if (transfer.current !== undefined) clear(transfer.current)
    if (exporting.current !== undefined) clear(exporting.current)
    transfer.current = undefined
    exporting.current = undefined
    setPhase('failed')
    setError(message)
  }
  const arm = (slot: Transfer | Export, timeout: number) => {
    clear(slot)
    slot.timer = setTimeout(() => stop(strings.chat.imageEditorFailedBody), timeout)
  }
  const sendChunk = (active: Transfer) => {
    arm(active, CHUNK_TIMEOUT_MS)
    send(`window.appendImageChunk(${JSON.stringify(active.id)},${active.sent},${JSON.stringify(source.data.slice(active.sent * CHUNK_CHARS, (active.sent + 1) * CHUNK_CHARS))})`)
  }
  const startTransfer = () => {
    if (terminal.current) return
    if (source.data.length === 0 || !BASE64.test(source.data)) {
      stop(strings.chat.imageEditorFailedBody)
      return
    }
    const active: Transfer = { id: String(revision), sent: 0, total: Math.ceil(source.data.length / CHUNK_CHARS) }
    transfer.current = active
    arm(active, CHUNK_TIMEOUT_MS)
    send(`window.beginImage(${JSON.stringify(active.id)},${JSON.stringify(source.mediaType)})`)
    sendChunk(active)
  }
  const finishExport = (active: Export) => {
    const base64 = active.chunks.join('')
    if (base64.length === 0 || !BASE64.test(base64) || active.chunks.length !== active.total) {
      stop(strings.chat.imageEditorFailedBody)
      return
    }
    const problem = onSave({ base64, width: active.width, height: active.height })
    if (problem !== undefined) {
      setPhase('ready')
      setError(problem)
    }
  }
  const onMessage = (event: WebViewMessageEvent) => {
    let message: Message
    try {
      message = JSON.parse(event.nativeEvent.data) as Message
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null) return
    if (message.type === 'page-ready') {
      if (!terminal.current && transfer.current === undefined) startTransfer()
      return
    }
    if (terminal.current) return
    if (message.type === 'image-ack') {
      const active = transfer.current
      if (active === undefined || message.index !== active.sent) return
      clear(active)
      active.sent += 1
      if (active.sent >= active.total) {
        arm(active, RENDER_TIMEOUT_MS)
        send(`window.finishImage(${JSON.stringify(active.id)})`)
        return
      }
      sendChunk(active)
      return
    }
    if (message.type === 'image-ready') {
      if (transfer.current !== undefined) clear(transfer.current)
      transfer.current = undefined
      setPhase('ready')
      setError(undefined)
      return
    }
    if (message.type === 'state') {
      setCanUndo(Boolean(message.canUndo))
      return
    }
    if (message.type === 'export-start') {
      if (exporting.current !== undefined) return
      const total = typeof message.total === 'number' && message.total > 0 ? message.total : 0
      const width = typeof message.width === 'number' && message.width > 0 ? Math.round(message.width) : 0
      const height = typeof message.height === 'number' && message.height > 0 ? Math.round(message.height) : 0
      if (total === 0 || width === 0 || height === 0) {
        stop(strings.chat.imageEditorFailedBody)
        return
      }
      const active: Export = { total, chunks: [], width, height }
      exporting.current = active
      arm(active, EXPORT_TIMEOUT_MS)
      return
    }
    if (message.type === 'export-chunk') {
      const active = exporting.current
      if (active === undefined || message.index !== active.chunks.length) return
      if (typeof message.data !== 'string' || message.data.length === 0) return
      active.chunks.push(message.data)
      arm(active, EXPORT_TIMEOUT_MS)
      send(`window.ackExportChunk(${message.index})`)
      return
    }
    if (message.type === 'export-end') {
      const active = exporting.current
      if (active === undefined) return
      clear(active)
      exporting.current = undefined
      finishExport(active)
      return
    }
    if (message.type === 'error') stop(strings.chat.imageEditorFailedBody)
  }
  const retry = () => {
    if (transfer.current !== undefined) clear(transfer.current)
    if (exporting.current !== undefined) clear(exporting.current)
    transfer.current = undefined
    exporting.current = undefined
    terminal.current = false
    setRevision(value => value + 1)
    setPhase('loading')
    setMode('crop')
    setCanUndo(false)
    setError(undefined)
  }
  const save = () => {
    if (phase !== 'ready' || terminal.current) return
    setPhase('exporting')
    setError(undefined)
    send('window.exportImage()')
  }
  const switchMode = (next: Mode) => {
    if (phase !== 'ready' || terminal.current || mode === next) return
    setMode(next)
    send(`window.setMode(${JSON.stringify(next)})`)
  }
  useEffect(() => {
    terminal.current = false
    setPhase('loading')
    setMode('crop')
    setCanUndo(false)
    setError(undefined)
    const timer = setTimeout(() => {
      if (!terminal.current && phaseRef.current === 'loading') stop(strings.chat.imageEditorFailedBody)
    }, READY_TIMEOUT_MS)
    return () => clearTimeout(timer)
    // A new revision remounts the page and restarts the chunked handshake.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])
  useEffect(() => () => {
    if (transfer.current !== undefined) clear(transfer.current)
    if (exporting.current !== undefined) clear(exporting.current)
    transfer.current = undefined
    exporting.current = undefined
    terminal.current = true
  }, [])

  const busy = phase === 'loading' || phase === 'exporting'
  const rendering = phase === 'exporting'
  return <Modal visible animationType="slide" statusBarTranslucent onRequestClose={onCancel}>
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <IconButton label={strings.common.cancel} icon={X} onPress={onCancel} />
        <Text numberOfLines={1} style={styles.title}>{strings.chat.imageEditorTitle}</Text>
        <Button label={strings.chat.imageEditorSave} onPress={save} loading={rendering} disabled={phase !== 'ready'} />
      </View>
      <View style={styles.stage}>
        <WebView
          ref={web}
          key={revision}
          source={webSource}
          style={styles.web}
          originWhitelist={['*']}
          javaScriptEnabled
          incognito
          cacheEnabled={false}
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          javaScriptCanOpenWindowsAutomatically={false}
          mixedContentMode="never"
          setSupportMultipleWindows
          onOpenWindow={() => undefined}
          onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
          onError={() => stop(strings.chat.imageEditorFailedBody)}
          onRenderProcessGone={() => stop(strings.chat.imageEditorFailedBody)}
          onContentProcessDidTerminate={() => stop(strings.chat.imageEditorFailedBody)}
          onMessage={onMessage}
        />
        {busy && <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.overlayText}>{strings.chat.imageEditorLoading}</Text>
        </View>}
        {phase === 'failed' && <View style={styles.overlay}>
          <Text accessibilityRole="alert" style={styles.overlayError}>{error ?? strings.chat.imageEditorFailedBody}</Text>
          <Button label={strings.common.retry} variant="secondary" onPress={retry} />
        </View>}
      </View>
      {error !== undefined && phase !== 'failed' && <Text accessibilityRole="alert" style={styles.errorBanner}>{error}</Text>}
      <View style={styles.toolbar}>
        <View style={styles.modeGroup}>
          <ModeButton active={mode === 'crop'} disabled={phase !== 'ready'} icon={Crop} label={strings.chat.imageEditorCrop} onPress={() => switchMode('crop')} />
          <ModeButton active={mode === 'draw'} disabled={phase !== 'ready'} icon={Paintbrush} label={strings.chat.imageEditorDraw} onPress={() => switchMode('draw')} />
        </View>
        <View style={styles.toolActions}>
          {mode === 'crop'
            ? <IconButton label={strings.chat.imageEditorResetCrop} icon={RotateCcw} dense disabled={phase !== 'ready'} onPress={() => send('window.resetCrop()')} />
            : <>
                <IconButton label={strings.chat.imageEditorUndo} icon={Undo2} dense disabled={phase !== 'ready' || !canUndo} onPress={() => send('window.undo()')} />
                <IconButton label={strings.chat.imageEditorClear} icon={Trash2} dense disabled={phase !== 'ready' || !canUndo} onPress={() => send('window.clearStrokes()')} />
              </>}
        </View>
      </View>
      <Text style={styles.hint}>{strings.chat.imageEditorHint}</Text>
    </View>
  </Modal>
}
function ModeButton({ active, disabled, icon: Icon, label, onPress }: {
  active: boolean
  disabled: boolean
  icon: typeof Crop
  label: string
  onPress: () => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => createStyles(colors), [colors])
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ selected: active, disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.modeButton, active && styles.modeButtonActive, pressed && !disabled && styles.modeButtonPressed, disabled && styles.modeButtonDisabled]}
  >
    <Icon size={16} color={active ? colors.primary : colors.ink} strokeWidth={2} />
    <Text style={[styles.modeButtonLabel, active && { color: colors.primary }]}>{label}</Text>
  </Pressable>
}

function createStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
    title: { ...typography.heading, color: colors.ink, flex: 1, textAlign: 'center' },
    stage: { flex: 1, backgroundColor: colors.background },
    web: { flex: 1, backgroundColor: colors.background },
    overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, backgroundColor: colors.background },
    overlayText: { ...typography.caption, color: colors.muted },
    overlayError: { ...typography.body, color: colors.danger, textAlign: 'center' },
    errorBanner: { ...typography.caption, color: colors.danger, paddingHorizontal: spacing.md, paddingBottom: spacing.xs },
    toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator, backgroundColor: colors.surface },
    modeGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    modeButton: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: spacing.sm, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong },
    modeButtonActive: { backgroundColor: colors.primarySoft },
    modeButtonPressed: { opacity: 0.72 },
    modeButtonDisabled: { opacity: 0.45 },
    modeButtonLabel: { ...typography.smallStrong, color: colors.ink },
    toolActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxs },
    hint: { ...typography.caption, color: colors.muted, paddingHorizontal: spacing.md, paddingBottom: spacing.sm, paddingTop: spacing.xxs },
  })
}
