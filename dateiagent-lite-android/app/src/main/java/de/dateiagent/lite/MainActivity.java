package de.dateiagent.lite;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.Context;
import android.content.UriPermission;
import android.content.ContentResolver;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.database.Cursor;
import android.view.View;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.io.FileNotFoundException;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
  static final int PICK=12, BG=Color.rgb(12,19,32), CARD=Color.rgb(26,38,56), INK=Color.rgb(233,243,253), MINT=Color.rgb(102,231,188), MUTED=Color.rgb(161,177,191);
  final ExecutorService worker=Executors.newSingleThreadExecutor();
  final List<Op> planned=new ArrayList<>();
  Uri tree;
  CommandParser.Command command;
  TextView folder,preview,status;
  EditText input;
  Button go,check,choose;
  boolean busy=false;
  static class Entry {
    Uri uri,parent;
    String name,mime;
    long bytes,modified;
    boolean dir;
    int depth;
    Entry(Uri u,Uri p,String n,String m,long b,long t,int d){
      uri=u;parent=p;name=n;mime=m;bytes=b;modified=t;dir=DocumentsContract.Document.MIME_TYPE_DIR.equals(m);depth=d;
    }
  }
  static class Op {
    Entry source;
    String target;
    boolean deleteEmpty;
    Op(Entry e,String t,boolean remove){source=e;target=t;deleteEmpty=remove;}
  }
  static class Frame {Uri parent;int depth;Frame(Uri u,int d){parent=u;depth=d;}}
  @Override public void onCreate(Bundle state){
    super.onCreate(state);
    getWindow().setStatusBarColor(BG);
    getWindow().setNavigationBarColor(BG);
    try {
      String saved=getPreferences(0).getString("folder",null);
      if(saved!=null) {
        Uri u=Uri.parse(saved);
        for(UriPermission p:getContentResolver().getPersistedUriPermissions()){
          if(p.getUri().equals(u)&&p.isReadPermission()&&p.isWritePermission()){tree=u;break;}
        }
      }
    }catch(Exception ignored){}
    ui();
    updateFolder();
  }
  int dp(int n){return (int)(n*getResources().getDisplayMetrics().density+.5f);}
  GradientDrawable bg(int c){GradientDrawable x=new GradientDrawable();x.setColor(c);x.setCornerRadius(dp(14));return x;}
  TextView label(String s,int size,int color,boolean heavy){
    TextView t=new TextView(this);t.setText(s);t.setTextSize(size);t.setTextColor(color);
    t.setLineSpacing(dp(3),1);if(heavy)t.setTypeface(Typeface.DEFAULT,Typeface.BOLD);return t;
  }
  Button button(String title){
    Button b=new Button(this);b.setText(title);b.setAllCaps(false);b.setTextColor(BG);
    b.setTextSize(15);b.setBackground(bg(MINT));return b;
  }
  LinearLayout vertical(){LinearLayout l=new LinearLayout(this);l.setOrientation(1);return l;}
  void add(LinearLayout parent,View child,int bottom){
    LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.bottomMargin=dp(bottom);parent.addView(child,lp);
  }
  void ui(){
    ScrollView sv=new ScrollView(this);sv.setFillViewport(true);sv.setBackgroundColor(BG);
    LinearLayout body=vertical();body.setPadding(dp(18),dp(26),dp(18),dp(40));sv.addView(body);setContentView(sv);
    add(body,label("DATEIAGENT  ·  LITE",12,MINT,true),8);
    add(body,label("Dateien per Prompt\norganisieren.",27,INK,true),10);
    add(body,label("Offline · Kein Konto · Kontrolle vor Änderungen",13,MUTED,false),23);
    LinearLayout panel=vertical();panel.setPadding(dp(15),dp(18),dp(15),dp(16));panel.setBackground(bg(CARD));
    add(panel,label("01  ORDNER AUSWÄHLEN",12,MINT,true),9);
    folder=label("Noch kein Ordner gewählt",14,INK,false);add(panel,folder,12);
    choose=button("Ordner freigeben");choose.setOnClickListener(v->pick());add(panel,choose,0);add(body,panel,22);
    add(body,label("02  WAS SOLL ICH TUN?",12,MINT,true),8);
    input=new EditText(this);input.setTextColor(INK);input.setHintTextColor(MUTED);input.setTextSize(16);
    input.setHint("z. B. Sortiere nach Dateityp");input.setMinLines(3);input.setMaxLines(5);
    input.setGravity(Gravity.TOP);input.setPadding(dp(15),dp(14),dp(15),dp(12));input.setBackground(bg(CARD));
    add(body,input,10);
    String[] examples={"Sortiere nach Dateityp","Sortiere nach Monat","Sortiere alphabetisch","Finde alle PDF-Dateien","Lösche doppelte Dateien","Lösche Dateien älter als 30 Tage","Lösche alle PDF-Dateien","Lösche leere Ordner"};
    for(String text:examples){
      TextView option=label("›  "+text,13,MUTED,false);option.setPadding(dp(8),dp(7),dp(8),dp(7));
      option.setOnClickListener(v->{input.setText(text);invalidatePlan();});add(body,option,0);
    }
    check=button("Auftrag prüfen");check.setOnClickListener(v->prepare());add(body,check,24);
    add(body,label("03  VORSCHAU",12,MINT,true),9);
    preview=label("Wähle einen Ordner und prüfe deinen Auftrag.",14,INK,false);
    preview.setBackground(bg(CARD));preview.setPadding(dp(15),dp(15),dp(15),dp(15));add(body,preview,12);
    go=button("Ausführen");go.setEnabled(false);go.setOnClickListener(v->confirm());add(body,go,12);
    status=label("Bereit.",13,MUTED,false);add(body,status,14);
    add(body,label("Löschen bedeutet: Dateien werden zuerst nach _DateiAgent_Papierkorb verschoben. Leere Ordner werden nach Bestätigung endgültig entfernt.",12,MUTED,false),0);
    input.addTextChangedListener(new android.text.TextWatcher(){
      public void beforeTextChanged(CharSequence s,int st,int c,int a){}
      public void onTextChanged(CharSequence s,int st,int before,int count){invalidatePlan();}
      public void afterTextChanged(android.text.Editable e){}
    });
  }
  void invalidatePlan(){planned.clear();command=null;if(go!=null)go.setEnabled(false);}
  void setBusy(boolean isBusy){busy=isBusy;check.setEnabled(!busy);choose.setEnabled(!busy);go.setEnabled(!busy&&!planned.isEmpty());}
  void updateFolder(){folder.setText(tree==null?"Noch kein Ordner ausgewählt":"Freigegeben: "+Uri.decode(tree.getLastPathSegment()));}
  void pick(){
    if(busy)return;
    Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
    startActivityForResult(i,PICK);
  }
  @Override protected void onActivityResult(int code,int result,Intent data){
    super.onActivityResult(code,result,data);
    if(code!=PICK||result!=RESULT_OK||data==null||data.getData()==null)return;
    Uri u=data.getData();
    try{
      getContentResolver().takePersistableUriPermission(u,Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
      tree=u;getPreferences(0).edit().putString("folder",u.toString()).apply();
      invalidatePlan();updateFolder();preview.setText("Ordner freigegeben. Gib jetzt deinen Auftrag ein.");status.setText("Bereit.");
    }catch(Exception e){status.setText("Keine dauerhafte Schreibfreigabe: "+e.getMessage());}
  }
  Uri root(){return DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));}
  List<Entry> children(Uri parent,int depth) throws IOException{
    ArrayList<Entry> result=new ArrayList<>();
    Uri uri=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getDocumentId(parent));
    String[] cols={DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_SIZE,DocumentsContract.Document.COLUMN_LAST_MODIFIED};
    try(Cursor c=getContentResolver().query(uri,cols,null,null,null)){
      if(c==null)throw new IOException("Ordner kann nicht gelesen werden");
      while(c.moveToNext()){
        String id=c.getString(0),name=c.getString(1),mime=c.getString(2);
        long size=c.isNull(3)?-1:c.getLong(3);
        long changed=c.isNull(4)?0:c.getLong(4);
        Uri doc=DocumentsContract.buildDocumentUriUsingTree(tree,id);
        if("_DateiAgent_Papierkorb".equals(name))continue;
        result.add(new Entry(doc,parent,name==null?"":name,mime==null?"":mime,size,changed,depth));
      }
    }catch(SecurityException x){throw new IOException("Keine Leseberechtigung",x);}
    return result;
  }
  List<Entry> walk() throws IOException{
    ArrayList<Entry> out=new ArrayList<>();
    ArrayDeque<Frame> q=new ArrayDeque<>();q.add(new Frame(root(),0));
    while(!q.isEmpty()){
      Frame f=q.removeFirst();
      if(f.depth>25)throw new IOException("Zu tiefe Ordnerstruktur (max. 25)");
      for(Entry e:children(f.parent,f.depth+1)){
        if(++scanCount>4000)throw new IOException("Zu viele Dateien (max. 4000)");
        out.add(e);
        if(e.dir)q.add(new Frame(e.uri,f.depth+1));
      }
    }
    return out;
  }
  int scanCount;
  void prepare(){
    if(tree==null){status.setText("Bitte zuerst einen Ordner freigeben.");return;}
    CommandParser.Command c=CommandParser.parse(input.getText().toString());
    invalidatePlan();
    if(c.type==CommandParser.Type.UNKNOWN){preview.setText("Befehl nicht unterstützt. Nutze einen der Vorschläge.");return;}
    command=c;setBusy(true);status.setText("Prüfe Dateien ...");
    worker.execute(()->{
      try{
        scanCount=0;
        List<Entry> all=(c.type==CommandParser.Type.SORT_TYPE||c.type==CommandParser.Type.SORT_MONTH||c.type==CommandParser.Type.SORT_YEAR||c.type==CommandParser.Type.SORT_LETTER)
              ?children(root(),1):walk();
        ArrayList<Op> actions=new ArrayList<>();
        boolean search=c.type==CommandParser.Type.FIND_EXTENSION||c.type==CommandParser.Type.FIND_NAME;
        StringBuilder result=new StringBuilder(c.display+"\n\n");
        Set<Uri> hasChildren=new HashSet<>();
        if(c.type==CommandParser.Type.DELETE_EMPTY){
          for(Entry e:all)hasChildren.add(e.parent);
        }
        Map<String,Entry> distinct=new HashMap<>();
        for(Entry e:all){
          if(search){
            boolean match=!e.dir && (c.type==CommandParser.Type.FIND_EXTENSION?extension(e.name).equalsIgnoreCase(c.value):e.name.toLowerCase(Locale.ROOT).contains(c.value.toLowerCase(Locale.ROOT)));
            if(match)actions.add(new Op(e,"",false));
          }else if(c.type==CommandParser.Type.DELETE_EMPTY){
            if(e.dir&&!hasChildren.contains(e.uri))actions.add(new Op(e,"",true));
          }else if(!e.dir){
            switch(c.type){
              case SORT_TYPE: actions.add(new Op(e,category(e.name),false));break;
              case SORT_MONTH: actions.add(new Op(e,dateFolder(e.modified,"yyyy-MM"),false));break;
              case SORT_YEAR: actions.add(new Op(e,dateFolder(e.modified,"yyyy"),false));break;
              case SORT_LETTER: actions.add(new Op(e,letterFolder(e.name),false));break;
              case DELETE_EXTENSION: if(extension(e.name).equalsIgnoreCase(c.value))actions.add(new Op(e,"_DateiAgent_Papierkorb",false));break;
              case DELETE_OLD: if(e.modified>0&&e.modified<System.currentTimeMillis()-((long)c.days*86400000L))actions.add(new Op(e,"_DateiAgent_Papierkorb",false));break;
              case DELETE_DUPLICATES:
                if(e.bytes>0&&e.bytes<=268435456L){
                  String hash=hash(e.uri);
                  String key=e.bytes+":"+hash;
                  if(distinct.containsKey(key))actions.add(new Op(e,"_DateiAgent_Papierkorb",false));else distinct.put(key,e);
                }
                break;
              default:break;
            }
          }
        }
        result.append(actions.size()).append(search?" Treffer":" geplante Aktionen").append("\n");
        int count=0;
        for(Op a:actions){
          if(count++==22){result.append("… weitere Einträge nicht angezeigt\n");break;}
          result.append("• ").append(a.source.name);
          if(!search&&!a.deleteEmpty)result.append(" → ").append(a.target);
          result.append('\n');
        }
        runOnUiThread(()->{
          if(command!=c){setBusy(false);return;}
          planned.addAll(actions);preview.setText(result.toString());
          status.setText(search?"Suche abgeschlossen.":actions.isEmpty()?"Keine Änderungen erforderlich.":"Prüfe die Liste und bestätige den Auftrag.");
          setBusy(false);
          if(search)go.setEnabled(false);
        });
      }catch(Exception e){runOnUiThread(()->{planned.clear();preview.setText("Prüfung fehlgeschlagen: "+e.getMessage());setBusy(false);});}
    });
  }
  String extension(String name){int p=name.lastIndexOf('.');return p<0?"":name.substring(p+1).toLowerCase(Locale.ROOT);}
  String category(String n){
    String x=extension(n);
    if(x.matches("jpg|jpeg|png|gif|webp|heic|bmp"))return "Bilder";
    if(x.matches("mp4|mov|avi|mkv|webm"))return "Videos";
    if(x.matches("mp3|wav|ogg|flac|m4a"))return "Audio";
    if(x.matches("pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|odt"))return "Dokumente";
    if(x.matches("zip|rar|7z|tar|gz"))return "Archive";
    if(x.equals("apk"))return "Apps";
    return "Sonstiges";
  }
  String letterFolder(String n){if(n.isEmpty())return "#";char ch=Character.toUpperCase(n.charAt(0));return Character.isLetterOrDigit(ch)?String.valueOf(ch):"#";}
  String dateFolder(long time,String format){return time>0?new SimpleDateFormat(format,Locale.GERMANY).format(new Date(time)):"Ohne Datum";}
  void confirm(){
    if(busy||planned.isEmpty()||command==null)return;
    String message=command.display+"\n"+planned.size()+" Einträge.\n\n"+(command.destructive()?"Dateien landen im internen Papierkorb. Leere Ordner werden endgültig entfernt.":"Dateien werden innerhalb des freigegebenen Ordners verschoben.");
    new AlertDialog.Builder(this).setTitle("Aktion bestätigen").setMessage(message).setNegativeButton("Abbrechen",null).setPositiveButton("Ausführen",(d,w)->execute()).show();
  }
  void execute(){
    if(busy||planned.isEmpty())return;
    List<Op> jobs=new ArrayList<>(planned);
    invalidatePlan();setBusy(true);status.setText("Führe Änderungen aus …");
    worker.execute(()->{
      int success=0,failed=0;StringBuilder problems=new StringBuilder();
      Map<String,Uri> destinations=new HashMap<>();
      for(Op op:jobs){
        try{
          if(op.deleteEmpty){
            if(!children(op.source.uri,op.source.depth+1).isEmpty())throw new IOException("Ordner ist nicht mehr leer");
            if(!DocumentsContract.deleteDocument(getContentResolver(),op.source.uri))throw new IOException("Ordner konnte nicht gelöscht werden");
          }else{
            Uri target=destinations.get(op.target);
            if(target==null){target=ensureDir(op.target);destinations.put(op.target,target);}
            if(target==null)throw new IOException("Zielordner fehlt");
            for(Entry existing:children(target,2))if(existing.name.equals(op.source.name))throw new IOException("Gleicher Dateiname im Ziel");
            move(op.source,target);
          }
          success++;
        }catch(Exception e){failed++;if(failed<=12)problems.append("• ").append(op.source.name).append(": ").append(e.getMessage()).append('\n');}
      }
      final int ok=success,errors=failed;
      runOnUiThread(()->{
        preview.setText("Fertig: "+ok+" erfolgreich, "+errors+" fehlgeschlagen.\n\n"+problems);
        status.setText(errors==0?"Auftrag abgeschlossen.":"Einige Aktionen konnten nicht ausgeführt werden.");
        setBusy(false);
      });
    });
  }
  Uri ensureDir(String folderName) throws IOException{
    for(Entry e:children(root(),1))if(e.name.equals(folderName)){
      if(e.dir)return e.uri;
      throw new IOException("Zielname ist bereits eine Datei: "+folderName);
    }
    Uri u=DocumentsContract.createDocument(getContentResolver(),root(),DocumentsContract.Document.MIME_TYPE_DIR,folderName);
    if(u==null)throw new IOException("Ordner konnte nicht erstellt werden");
    return u;
  }
  void move(Entry e,Uri target) throws Exception{
    try{
      Uri moved=DocumentsContract.moveDocument(getContentResolver(),e.uri,e.parent,target);
      if(moved!=null)return;
    }catch(Exception unsupported){ /* Einige Speicheranbieter unterstützen MOVE nicht. */ }
    // Fallback: erst vollständig kopieren, dann prüfen, dann Original entfernen.
    Uri dest=null;
    try{
      String mime=e.mime.isEmpty()?"application/octet-stream":e.mime;
      dest=DocumentsContract.createDocument(getContentResolver(),target,mime,e.name);
      if(dest==null)throw new IOException("Kopie konnte nicht erstellt werden");
      byte[] buf=new byte[65536];int n;
      MessageDigest m=MessageDigest.getInstance("SHA-256");
      try(InputStream in=getContentResolver().openInputStream(e.uri);OutputStream out=getContentResolver().openOutputStream(dest,"w")){
        if(in==null||out==null)throw new IOException("Datei kann nicht geöffnet werden");
        while((n=in.read(buf))!=-1){out.write(buf,0,n);m.update(buf,0,n);}
        out.flush();
      }
      if(!hex(m.digest()).equals(hash(dest)))throw new IOException("Kopie stimmt nicht mit Original überein");
      if(!DocumentsContract.deleteDocument(getContentResolver(),e.uri))throw new IOException("Original konnte nicht entfernt werden; Kopie ist erhalten");
    }catch(Exception ex){
      // Bei fehlgeschlagenem Löschen existiert eine verifizierte Kopie – diese wird behalten.
      if(dest!=null&&!(ex.getMessage()!=null&&ex.getMessage().startsWith("Original konnte"))){
        try{DocumentsContract.deleteDocument(getContentResolver(),dest);}catch(Exception ignored){}
      }
      throw ex;
    }
  }
  String hash(Uri uri) throws Exception{
    MessageDigest md=MessageDigest.getInstance("SHA-256");
    try(InputStream in=getContentResolver().openInputStream(uri)){
      if(in==null)throw new IOException("Datei kann nicht gelesen werden");
      byte[] b=new byte[65536];int n;
      while((n=in.read(b))!=-1)md.update(b,0,n);
    }
    return hex(md.digest());
  }
  String hex(byte[] bytes){
    StringBuilder out=new StringBuilder(bytes.length*2);
    for(byte b:bytes)out.append(String.format(Locale.ROOT,"%02x",b&255));
    return out.toString();
  }
  @Override protected void onDestroy(){super.onDestroy();worker.shutdown(); }
}
