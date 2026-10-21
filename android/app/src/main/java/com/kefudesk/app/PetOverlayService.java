package com.kefudesk.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.core.app.NotificationCompat;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

public class PetOverlayService extends Service {
    public static final String ACTION_START = "com.kefudesk.app.PET_START";
    private static final String CHANNEL_ID = "kefu-pet-overlay";
    private static PetOverlayService instance;
    private final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
    private WindowManager windowManager;
    private ImageView petView;
    private LinearLayout panelView;
    private WindowManager.LayoutParams petParams;
    private WindowManager.LayoutParams panelParams;
    private View petMenuView;
    private Runnable petLongPressRunnable;
    private EditText searchInput;
    private LinearLayout categoryRow;
    private LinearLayout phraseList;
    private TextView panelStatus;
    private Runnable panelStatusReset;
    private String query = "";
    private String selectedCategory = "all";
    private JSONObject library = new JSONObject();

    public static boolean isRunning() {
        return instance != null && instance.petView != null;
    }

    public static void closePanel() {
        PetOverlayService current = instance;
        if (current != null) current.handler.post(current::hidePanel);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        createNotificationChannel();
        startForeground(2407, buildNotification());
        showPet();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_START.equals(intent.getAction())) showPet();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        hidePanel();
        hidePetMenu();
        if (petLongPressRunnable != null) handler.removeCallbacks(petLongPressRunnable);
        if (petView != null) {
            try { windowManager.removeView(petView); } catch (Exception ignored) {}
            petView = null;
        }
        instance = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void showPet() {
        if (petView != null || Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !android.provider.Settings.canDrawOverlays(this)) return;
        int size = dp(74);
        petView = new ImageView(this);
        petView.setImageResource(R.drawable.pet_avatar);
        petView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        GradientDrawable bubble = new GradientDrawable();
        bubble.setShape(GradientDrawable.OVAL);
        bubble.setColor(Color.WHITE);
        bubble.setStroke(dp(1), Color.rgb(224, 233, 241));
        petView.setBackground(bubble);
        petView.setPadding(dp(3), dp(3), dp(3), dp(3));
        petView.setElevation(dp(7));
        petParams = new WindowManager.LayoutParams(size, size, overlayWindowType(), WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN, PixelFormat.TRANSLUCENT);
        petParams.gravity = Gravity.TOP | Gravity.LEFT;
        android.content.SharedPreferences preferences = getSharedPreferences("kefu-pet", MODE_PRIVATE);
        int maxX = Math.max(0, getResources().getDisplayMetrics().widthPixels - size);
        petParams.x = Math.min(maxX, Math.max(0, preferences.getInt("x", maxX)));
        petParams.y = Math.max(0, preferences.getInt("y", dp(230)));
        petView.setOnTouchListener(new View.OnTouchListener() {
            private float downX;
            private float downY;
            private int startX;
            private int startY;
            private boolean moved;
            private boolean longPressed;

            @Override
            public boolean onTouch(View view, MotionEvent event) {
                if (event.getAction() == MotionEvent.ACTION_DOWN) {
                    downX = event.getRawX();
                    downY = event.getRawY();
                    startX = petParams.x;
                    startY = petParams.y;
                    moved = false;
                    longPressed = false;
                    if (petLongPressRunnable != null) handler.removeCallbacks(petLongPressRunnable);
                    petLongPressRunnable = () -> {
                        if (!moved && petView != null) {
                            longPressed = true;
                            showPetMenu();
                        }
                    };
                    handler.postDelayed(petLongPressRunnable, ViewConfiguration.getLongPressTimeout());
                    return true;
                }
                if (event.getAction() == MotionEvent.ACTION_MOVE) {
                    if (longPressed) return true;
                    int dx = Math.round(event.getRawX() - downX);
                    int dy = Math.round(event.getRawY() - downY);
                    if (Math.abs(dx) + Math.abs(dy) > dp(5)) {
                        moved = true;
                        if (petLongPressRunnable != null) handler.removeCallbacks(petLongPressRunnable);
                    }
                    if (moved) {
                        int screenWidth = getResources().getDisplayMetrics().widthPixels;
                        int screenHeight = getResources().getDisplayMetrics().heightPixels;
                        petParams.x = Math.max(0, Math.min(screenWidth - size, startX + dx));
                        petParams.y = Math.max(0, Math.min(screenHeight - size, startY + dy));
                        try { windowManager.updateViewLayout(petView, petParams); } catch (Exception ignored) {}
                    }
                    return true;
                }
                if (event.getAction() == MotionEvent.ACTION_UP) {
                    if (petLongPressRunnable != null) handler.removeCallbacks(petLongPressRunnable);
                    if (longPressed) return true;
                    if (moved) {
                        int screenWidth = getResources().getDisplayMetrics().widthPixels;
                        petParams.x = petParams.x < screenWidth / 2 ? 0 : Math.max(0, screenWidth - size);
                        preferences.edit().putInt("x", petParams.x).putInt("y", petParams.y).apply();
                        try { windowManager.updateViewLayout(petView, petParams); } catch (Exception ignored) {}
                    } else {
                        hidePetMenu();
                        togglePanel();
                    }
                    return true;
                }
                if (event.getAction() == MotionEvent.ACTION_CANCEL) {
                    if (petLongPressRunnable != null) handler.removeCallbacks(petLongPressRunnable);
                    return true;
                }
                return true;
            }
        });
        try { windowManager.addView(petView, petParams); } catch (Exception error) { petView = null; }
    }

    private void showPetMenu() {
        hidePetMenu();
        if (petView == null || petParams == null) return;
        LinearLayout menu = new LinearLayout(this);
        menu.setGravity(Gravity.CENTER);
        menu.setPadding(dp(5), dp(4), dp(5), dp(4));
        menu.setElevation(dp(10));
        GradientDrawable menuBackground = new GradientDrawable();
        menuBackground.setColor(Color.WHITE);
        menuBackground.setCornerRadius(dp(12));
        menuBackground.setStroke(dp(1), Color.rgb(238, 220, 220));
        menu.setBackground(menuBackground);
        TextView exit = text("退出", 14, Color.rgb(179, 67, 67), true);
        exit.setGravity(Gravity.CENTER);
        GradientDrawable exitBackground = new GradientDrawable();
        exitBackground.setColor(Color.rgb(255, 242, 241));
        exitBackground.setCornerRadius(dp(9));
        exit.setBackground(exitBackground);
        exit.setContentDescription("退出客服宝宠物悬浮窗");
        exit.setOnClickListener(view -> {
            hidePetMenu();
            stopSelf();
        });
        menu.addView(exit, new LinearLayout.LayoutParams(-1, -1));
        menu.setOnTouchListener((view, event) -> {
            if (event.getAction() == MotionEvent.ACTION_OUTSIDE) {
                hidePetMenu();
                return true;
            }
            return false;
        });
        int menuWidth = dp(92);
        int menuHeight = dp(48);
        android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(menuWidth, menuHeight, overlayWindowType(), WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN, PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.LEFT;
        params.x = Math.max(0, Math.min(metrics.widthPixels - menuWidth, petParams.x + (dp(74) - menuWidth) / 2));
        int belowPet = petParams.y + dp(74) + dp(7);
        params.y = belowPet + menuHeight <= metrics.heightPixels ? belowPet : Math.max(0, petParams.y - menuHeight - dp(7));
        try {
            windowManager.addView(menu, params);
            petMenuView = menu;
        } catch (Exception ignored) {
            petMenuView = null;
        }
    }

    private void hidePetMenu() {
        if (petMenuView == null) return;
        try { windowManager.removeView(petMenuView); } catch (Exception ignored) {}
        petMenuView = null;
    }

    private void togglePanel() {
        if (panelView == null) showPanel();
        else hidePanel();
    }

    private void showPanel() {
        loadLibrary();
        panelView = new LinearLayout(this);
        panelView.setOrientation(LinearLayout.VERTICAL);
        panelView.setPadding(dp(15), dp(13), dp(15), dp(12));
        panelView.setElevation(dp(16));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.rgb(250, 252, 255));
        background.setCornerRadius(dp(19));
        background.setStroke(dp(1), Color.rgb(216, 225, 237));
        panelView.setBackground(background);
        panelView.setFocusableInTouchMode(true);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        ImageView icon = new ImageView(this);
        icon.setImageResource(R.drawable.pet_avatar);
        icon.setScaleType(ImageView.ScaleType.CENTER_CROP);
        header.addView(icon, new LinearLayout.LayoutParams(dp(38), dp(38)));
        LinearLayout heading = new LinearLayout(this);
        heading.setOrientation(LinearLayout.VERTICAL);
        heading.setPadding(dp(9), 0, 0, 0);
        TextView title = text("快回 · 话术浮窗", 15, Color.rgb(34, 52, 72), true);
        TextView workspaceLabel = text(activeWorkspace().equals("cloud") ? "坚果云云端工作区" : "本机工作区", 10, Color.rgb(125, 143, 160), false);
        heading.addView(title);
        heading.addView(workspaceLabel);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        TextView zoomOut = createPanelSizeButton("−", "缩小浮窗", () -> adjustPanelScale(-0.1f));
        header.addView(zoomOut, new LinearLayout.LayoutParams(dp(31), dp(34)));
        TextView zoomIn = createPanelSizeButton("+", "放大浮窗", () -> adjustPanelScale(0.1f));
        LinearLayout.LayoutParams zoomInParams = new LinearLayout.LayoutParams(dp(31), dp(34));
        zoomInParams.leftMargin = dp(3);
        header.addView(zoomIn, zoomInParams);
        TextView close = text("×", 25, Color.rgb(118, 135, 153), false);
        close.setGravity(Gravity.CENTER);
        close.setOnClickListener(view -> hidePanel());
        header.addView(close, new LinearLayout.LayoutParams(dp(34), dp(38)));
        panelView.addView(header);

        searchInput = new EditText(this);
        searchInput.setSingleLine(true);
        searchInput.setTextSize(13);
        searchInput.setHint("搜索话术、标签");
        searchInput.setPadding(dp(11), 0, dp(11), 0);
        searchInput.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
        GradientDrawable searchBackground = new GradientDrawable();
        searchBackground.setColor(Color.WHITE);
        searchBackground.setCornerRadius(dp(10));
        searchBackground.setStroke(dp(1), Color.rgb(225, 232, 239));
        searchInput.setBackground(searchBackground);
        LinearLayout.LayoutParams searchParams = new LinearLayout.LayoutParams(-1, dp(44));
        searchParams.topMargin = dp(12);
        panelView.addView(searchInput, searchParams);

        HorizontalScrollView categoriesScroll = new HorizontalScrollView(this);
        categoriesScroll.setHorizontalScrollBarEnabled(false);
        categoryRow = new LinearLayout(this);
        categoryRow.setGravity(Gravity.CENTER_VERTICAL);
        categoriesScroll.addView(categoryRow);
        LinearLayout.LayoutParams categoryParams = new LinearLayout.LayoutParams(-1, dp(43));
        panelView.addView(categoriesScroll, categoryParams);

        ScrollView scroll = new ScrollView(this);
        phraseList = new LinearLayout(this);
        phraseList.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(phraseList);
        panelView.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        panelStatus = text("点选话术即可复制，拖动宠物可调整位置", 10, Color.rgb(136, 151, 166), false);
        panelStatus.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams footerParams = new LinearLayout.LayoutParams(-1, dp(27));
        footerParams.topMargin = dp(4);
        panelView.addView(panelStatus, footerParams);

        searchInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) { query = value.toString().trim().toLowerCase(); renderPhrases(); }
            @Override public void afterTextChanged(Editable value) {}
        });
        float panelScale = getSharedPreferences("kefu-pet", MODE_PRIVATE).getFloat("panelScale", 1f);
        panelScale = Math.max(0.8f, Math.min(1.4f, panelScale));
        panelParams = new WindowManager.LayoutParams(Math.min(dp(370 * panelScale), getResources().getDisplayMetrics().widthPixels - dp(24)), Math.min(dp(610 * panelScale), getResources().getDisplayMetrics().heightPixels - dp(100)), overlayWindowType(), WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN, PixelFormat.TRANSLUCENT);
        panelParams.gravity = Gravity.CENTER;
        panelParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        try {
            windowManager.addView(panelView, panelParams);
            renderCategories();
            renderPhrases();
        } catch (Exception error) {
            panelView = null;
        }
    }

    private void hidePanel() {
        if (panelView == null) return;
        if (panelStatusReset != null) handler.removeCallbacks(panelStatusReset);
        panelStatusReset = null;
        try { windowManager.removeView(panelView); } catch (Exception ignored) {}
        panelView = null;
        searchInput = null;
        categoryRow = null;
        phraseList = null;
        panelStatus = null;
    }

    private TextView createPanelSizeButton(String label, String description, Runnable action) {
        TextView button = text(label, 20, Color.rgb(91, 111, 130), true);
        button.setGravity(Gravity.CENTER);
        button.setContentDescription(description);
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.rgb(239, 244, 248));
        background.setCornerRadius(dp(9));
        button.setBackground(background);
        button.setOnClickListener(view -> action.run());
        return button;
    }

    private void adjustPanelScale(float delta) {
        if (panelView == null || panelParams == null) return;
        android.content.SharedPreferences preferences = getSharedPreferences("kefu-pet", MODE_PRIVATE);
        float currentScale = preferences.getFloat("panelScale", 1f);
        float scale = Math.max(0.8f, Math.min(1.4f, Math.round((currentScale + delta) * 10f) / 10f));
        android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
        panelParams.width = Math.min(dp(370 * scale), metrics.widthPixels - dp(24));
        panelParams.height = Math.min(dp(610 * scale), metrics.heightPixels - dp(100));
        preferences.edit().putFloat("panelScale", scale).apply();
        try { windowManager.updateViewLayout(panelView, panelParams); } catch (Exception ignored) {}
    }

    private void showPanelStatus(String message, boolean success) {
        if (panelStatus == null) return;
        if (panelStatusReset != null) handler.removeCallbacks(panelStatusReset);
        panelStatus.setText(message);
        panelStatus.setTextColor(success ? Color.rgb(40, 145, 113) : Color.rgb(188, 86, 78));
        panelStatusReset = () -> {
            if (panelStatus == null) return;
            panelStatus.setText("点选话术即可复制，拖动宠物可调整位置");
            panelStatus.setTextColor(Color.rgb(136, 151, 166));
            panelStatusReset = null;
        };
        handler.postDelayed(panelStatusReset, 2200);
    }

    private void loadLibrary() {
        String workspace = activeWorkspace();
        String fileName = workspace.equals("cloud") ? "cloud-library.json" : "local-library.json";
        File file = new File(getFilesDir(), fileName);
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            library = new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
        } catch (Exception error) {
            library = new JSONObject();
        }
    }

    private String activeWorkspace() {
        return getSharedPreferences("kefu-app", MODE_PRIVATE).getString("workspace", "local");
    }

    private void renderCategories() {
        if (categoryRow == null) return;
        categoryRow.removeAllViews();
        addCategory("全部", "all");
        JSONArray categories = library.optJSONArray("categories");
        if (categories == null) return;
        for (int index = 0; index < categories.length(); index++) {
            JSONObject category = categories.optJSONObject(index);
            if (category != null) addCategory(category.optString("name", "分类"), category.optString("id", ""));
        }
    }

    private void addCategory(String name, String id) {
        TextView chip = text(name, 11, id.equals(selectedCategory) ? Color.WHITE : Color.rgb(75, 94, 114), true);
        chip.setGravity(Gravity.CENTER);
        chip.setPadding(dp(12), 0, dp(12), 0);
        GradientDrawable background = new GradientDrawable();
        background.setColor(id.equals(selectedCategory) ? Color.rgb(72, 100, 169) : Color.rgb(239, 243, 249));
        background.setCornerRadius(dp(16));
        chip.setBackground(background);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, dp(29));
        params.rightMargin = dp(7);
        categoryRow.addView(chip, params);
        chip.setOnClickListener(view -> {
            selectedCategory = id;
            renderCategories();
            renderPhrases();
        });
    }

    private void renderPhrases() {
        if (phraseList == null) return;
        phraseList.removeAllViews();
        JSONArray phrases = library.optJSONArray("phrases");
        if (phrases == null) {
            phraseList.addView(emptyLabel("还没有话术，打开客服宝添加或同步"));
            return;
        }
        int shown = 0;
        for (int index = 0; index < phrases.length() && shown < 120; index++) {
            JSONObject phrase = phrases.optJSONObject(index);
            if (phrase == null) continue;
            String categoryId = phrase.optString("categoryId", "");
            if (!selectedCategory.equals("all") && !selectedCategory.equals(categoryId)) continue;
            JSONArray tags = phrase.optJSONArray("tags");
            String searchable = (phrase.optString("title", "") + " " + phrase.optString("text", "") + " " + (tags == null ? "" : tags.toString())).toLowerCase();
            if (!query.isEmpty() && !searchable.contains(query)) continue;
            addPhraseRow(phrase, categoryName(categoryId));
            shown += 1;
        }
        if (shown == 0) phraseList.addView(emptyLabel("没有找到匹配的话术"));
    }

    private void addPhraseRow(JSONObject phrase, String categoryName) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(dp(12), dp(10), dp(12), dp(10));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.WHITE);
        background.setCornerRadius(dp(12));
        background.setStroke(dp(1), Color.rgb(229, 235, 243));
        row.setBackground(background);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2);
        rowParams.bottomMargin = dp(8);
        phraseList.addView(row, rowParams);
        LinearLayout titleRow = new LinearLayout(this);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = text(phrase.optString("title", "未命名话术"), 13, Color.rgb(39, 55, 75), true);
        title.setMaxLines(1);
        titleRow.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        TextView category = text(categoryName, 10, Color.rgb(129, 143, 161), false);
        titleRow.addView(category);
        row.addView(titleRow);
        String body = phrase.optString("text", "").trim();
        JSONArray images = phrase.optJSONArray("images");
        if (images == null && phrase.optString("image", "").startsWith("data:image/")) {
            images = new JSONArray().put(phrase.optString("image"));
        }
        JSONArray videos = phrase.optJSONArray("videos");
        int videoCount = videos == null ? 0 : videos.length();
        String emptyBody = images != null && images.length() > 0 ? "图片话术 · " + images.length() + " 张图片" : videoCount > 0 ? "视频附件 · " + videoCount + " 个（安卓端暂不支持播放）" : "无文字内容";
        TextView content = text(body.isEmpty() ? emptyBody : body, 11, Color.rgb(88, 105, 124), false);
        content.setMaxLines(3);
        content.setPadding(0, dp(6), 0, 0);
        row.addView(content);
        if (images != null && images.length() > 0 && !body.isEmpty()) {
            TextView imageCount = text("图片附件 · " + images.length() + " 张", 10, Color.rgb(117, 131, 153), false);
            imageCount.setPadding(0, dp(5), 0, 0);
            row.addView(imageCount);
        }
        if (videoCount > 0 && (!body.isEmpty() || images != null && images.length() > 0)) {
            TextView videoInfo = text("视频附件 · " + videoCount + " 个（安卓端暂不支持播放）", 10, Color.rgb(117, 131, 153), false);
            videoInfo.setPadding(0, dp(5), 0, 0);
            row.addView(videoInfo);
        }
        JSONArray copiedImages = images == null ? new JSONArray() : images;
        String copiedText = body;
        row.setOnClickListener(view -> {
            try {
                List<String> imageValues = new ArrayList<>();
                for (int index = 0; index < copiedImages.length(); index++) imageValues.add(copiedImages.getString(index));
                if (copiedText.isEmpty() && imageValues.isEmpty() && videoCount > 0) showPanelStatus("暂不支持复制视频", false);
                else if (AndroidClipboard.copy(this, copiedText, imageValues)) showPanelStatus(videoCount > 0 ? "已复制，视频附件暂不支持" : "复制成功，可回聊天窗口粘贴", true);
                else showPanelStatus("没有可复制的内容", false);
            } catch (Exception error) {
                showPanelStatus("复制失败，请重试", false);
            }
        });
    }

    private String categoryName(String id) {
        JSONArray categories = library.optJSONArray("categories");
        if (categories == null) return "";
        for (int index = 0; index < categories.length(); index++) {
            JSONObject category = categories.optJSONObject(index);
            if (category != null && id.equals(category.optString("id"))) return category.optString("name", "");
        }
        return "";
    }

    private View emptyLabel(String value) {
        TextView label = text(value, 12, Color.rgb(123, 139, 158), false);
        label.setGravity(Gravity.CENTER);
        label.setPadding(dp(10), dp(30), dp(10), dp(30));
        return label;
    }

    private TextView text(String value, float size, int color, boolean bold) {
        TextView text = new TextView(this);
        text.setText(value);
        text.setTextSize(size);
        text.setTextColor(color);
        if (bold) text.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return text;
    }

    private int overlayWindowType() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "客服宝宠物悬浮窗", NotificationManager.IMPORTANCE_MIN);
        channel.setDescription("保持客服宝宠物悬浮入口可用");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = launchIntent == null ? null : PendingIntent.getActivity(this, 0, launchIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_kefu)
            .setContentTitle("客服宝宠物悬浮窗已开启")
            .setContentText("点击蓝发鲸鱼宠物，呼出快捷话术浮窗")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN);
        if (pendingIntent != null) builder.setContentIntent(pendingIntent);
        return builder.build();
    }
}
