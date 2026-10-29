package de.dateiagent.lite;
import java.text.Normalizer;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
public final class CommandParser {
  public enum Type { SORT_TYPE, SORT_MONTH, SORT_YEAR, SORT_LETTER, DELETE_EXTENSION, DELETE_OLD, DELETE_EMPTY, DELETE_DUPLICATES, FIND_EXTENSION, FIND_NAME, UNKNOWN }
  public static final class Command {
    public final Type type;
    public final String value;
    public final int days;
    public final String display;
    Command(Type t, String v, int d, String s){type=t;value=v;days=d;display=s;}
    public boolean destructive(){return type==Type.DELETE_EXTENSION || type==Type.DELETE_OLD || type==Type.DELETE_EMPTY || type==Type.DELETE_DUPLICATES;}
  }
  static Command create(Type t,String v,int days,String label){return new Command(t,v,days,label);}
  static Command fail(){return create(Type.UNKNOWN,"",0,"Befehl nicht erkannt");}
  public static Command parse(String original){
    if(original==null)return fail();
    String s=Normalizer.normalize(original.toLowerCase(Locale.ROOT),Normalizer.Form.NFD).replaceAll("\\p{M}+","").replace("ß","ss").trim();
    if(s.isEmpty()||s.contains(";")||s.contains("\n")||s.matches("(?s).*\\bund\\b.*")||s.matches("(?s).*\\b(nicht|ausser|ohne|behalte|ausgenommen)\\b.*")||s.contains(" nur ")||s.contains(" im ordner "))return fail();
    boolean del=s.matches("(?s).*(losch|loesch|entfern|bereinig|papierkorb).*");
    boolean find=s.matches("(?s).*(find|such|zeig|liste|auflist).*");
    boolean sort=s.matches("(?s).*(sortier|ordne|organisier|aufraum|raum).*");
    String ext=null;
    Matcher m=Pattern.compile("(?:\\*\\.|\\.)([a-z0-9]{1,10})(?![a-z0-9])").matcher(s);
    if(m.find())ext=m.group(1);
    else{m=Pattern.compile("\\b(pdf|docx?|xlsx?|pptx?|txt|csv|jpe?g|png|webp|gif|heic|mp4|mov|mkv|avi|mp3|wav|ogg|flac|zip|rar|7z|apk|json|xml|tmp|log)\\b").matcher(s);if(m.find())ext=m.group(1);}
    if(del){
      if(s.contains("doppel")||s.contains("duplikat"))return ext==null?create(Type.DELETE_DUPLICATES,"",0,"Doppelte Dateien entfernen"):fail();
      if(s.contains("leere ordner")||s.contains("leeren ordner"))return create(Type.DELETE_EMPTY,"",0,"Leere Unterordner entfernen");
      m=Pattern.compile("(aelter|alter)\\s+als\\s+(\\d{1,5})\\s*(tage?|wochen?|monate?|jahre?)").matcher(s);
      if(m.find()){
        if(ext!=null)return fail();
        int n=Integer.parseInt(m.group(2)); if(n==0)return fail();
        String u=m.group(3);
        int factor=u.startsWith("woch")?7:u.startsWith("monat")?30:u.startsWith("jahr")?365:1;
        return create(Type.DELETE_OLD,"",n*factor,"Dateien älter als "+n+" "+u+" entfernen");
      }
      return ext==null?fail():create(Type.DELETE_EXTENSION,ext,0,"."+ext+"-Dateien entfernen");
    }
    if(find){
      if(ext!=null)return create(Type.FIND_EXTENSION,ext,0,"."+ext+"-Dateien suchen");
      m=Pattern.compile("(?:namens|name)\\s+[\"']?([a-z0-9._-]{2,50})").matcher(s);
      return m.find()?create(Type.FIND_NAME,m.group(1),0,"Dateien mit "+m.group(1)+" suchen"):fail();
    }
    if(sort){
      if(ext!=null)return fail();
      if(s.contains("monat")||s.contains("datum"))return create(Type.SORT_MONTH,"",0,"Nach Monat sortieren");
      if(s.contains("jahr"))return create(Type.SORT_YEAR,"",0,"Nach Jahr sortieren");
      if(s.contains("alphabet")||s.contains("buchstabe")||s.contains("namen"))return create(Type.SORT_LETTER,"",0,"Alphabetisch sortieren");
      return create(Type.SORT_TYPE,"",0,"Nach Dateityp sortieren");
    }
    return fail();
  }
}
